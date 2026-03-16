import cds from '@sap/cds'
import { Booking, BookingSupplement as Supplements, Travel } from '#cds-models/TravelService'
import { TravelStatusCode } from '#cds-models/sap/fe/cap/travel'
import { CdsDate } from '#cds-models/_'
import { executeHttpRequest } from '@sap-cloud-sdk/http-client'
import { getDestination, HttpDestination } from '@sap-cloud-sdk/connectivity'

cds.on('bootstrap', (app: any) => {
  app.use((req: any, _res: any, next: any) => {
    if (req.path?.includes('rejectTravel') || req.path?.includes('acceptTravel')) {
      const auth = req.headers?.authorization || ''
      if (auth.startsWith('Bearer ')) {
        try {
          const p = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString())
          console.log('[SBPA-TOKEN]', JSON.stringify({ scope: p.scope, client_id: p.client_id, sub: p.sub, aud: p.aud }))
        } catch(e) { console.log('[SBPA-TOKEN] decode failed') }
      }
    }
    next()
  })
})

export class TravelService extends cds.ApplicationService { init() {

  // Reflected definitions from the service's CDS model
  const { today } = cds.builtin.types.Date as unknown as { today(): CdsDate };


  // Fill in alternative keys as consecutive numbers for new Travels, Bookings, and Supplements.
  // Note: For Travels that can't be done at NEW events, that is when drafts are created,
  // but on CREATE only, as multiple users could create new Travels concurrently.

  this.before ('CREATE', Travel, async req => {
    let { maxID } = await SELECT.one (`max(TravelID) as maxID`) .from (Travel) as { maxID: number }
    req.data.TravelID = ++maxID
  })

  this.before ('NEW', Booking.drafts, async req => {
    let { maxID } = await SELECT.one (`max(BookingID) as maxID`) .from (Booking.drafts) .where (req.data) as { maxID: number }
    req.data.BookingID = ++maxID
    req.data.BookingDate = today() // REVISIT: could that be filled in by CAP automatically?
  })

  this.before ('NEW', Supplements.drafts, async req => {
    let { maxID } = await SELECT.one (`max(BookingSupplementID) as maxID`) .from (Supplements.drafts) .where (req.data) as { maxID: number }
    req.data.BookingSupplementID = ++maxID
  })


  // Ensure BeginDate is not before today and not after EndDate.
  this.before ('SAVE', Travel, req => {
    const { BeginDate, EndDate } = req.data
    if (BeginDate < today()) req.error (400, `Begin Date must not be before today.`, 'in/BeginDate')
    if (BeginDate > EndDate) req.error (400, `End Date must be after Begin Date.`, 'in/EndDate')
  })


  // Update a Travel's TotalPrice whenever its BookingFee is modified,
  // or when a nested Booking is deleted or its FlightPrice is modified,
  // or when a nested Supplement is deleted or its Price is modified.

  this.on ('UPDATE', Travel.drafts,      (req, next) => update_totals (req, next, ['BookingFee', 'GoGreen']))
  this.on ('UPDATE', Booking.drafts,     (req, next) => update_totals (req, next, ['FlightPrice']))
  this.on ('UPDATE', Supplements.drafts, (req, next) => update_totals (req, next, ['Price']))
  this.on ('DELETE', Booking.drafts,     (req, next) => update_totals (req, next))
  this.on ('DELETE', Supplements.drafts, (req, next) => update_totals (req, next))

  // Note: using .on handlers as we need to read a Booking's or Supplement's TravelUUID before they are deleted.
  async function update_totals (req: cds.Request, next: Function, fields?: string[]) {
    if (fields && !fields.some(f => f in req.data)) return next() //> skip if no relevant data changed
    const travel = (req.data as Travel).TravelUUID || ( await SELECT.one `to_Travel.TravelUUID as id` .from (req.subject) ).id
    await next() // actually UPDATE or DELETE the subject entity
    await update_totalsGreen(travel);
    await cds.run(`UPDATE ${Travel.drafts} SET TotalPrice = coalesce (BookingFee,0)
     + coalesce(GreenFee,0)
     + ( SELECT coalesce (sum(FlightPrice),0) from ${Booking.drafts} where to_Travel_TravelUUID = TravelUUID )
     + ( SELECT coalesce (sum(Price),0) from ${Supplements.drafts} where to_Travel_TravelUUID = TravelUUID )
    WHERE TravelUUID = ?`, [travel])
  }

  /**
   * Trees-for-Tickets: helper to update totals including green flight fee
   */
  async function update_totalsGreen(TravelUUID: string) {
    const { GoGreen } = await SELECT.one .from(Travel.drafts) .columns('GoGreen') .where({ TravelUUID })
    if (GoGreen) {
      await UPDATE(Travel.drafts, TravelUUID)
        .set `GreenFee = round(BookingFee * 0.1, 0)`
        .set `TreesPlanted = round(BookingFee * 0.1, 0)`
    } else {
      await UPDATE(Travel.drafts, TravelUUID)
        .set `GreenFee = 0`
        .set `TreesPlanted = 0`
    }
  }


  //
  // Action Implementations...
  //

  const { acceptTravel, rejectTravel, deductDiscount, submitForApproval } = Travel.actions;
  this.before([acceptTravel, rejectTravel], [Travel, Travel.drafts], async (req) => {
    const existingDraft = await SELECT.one(Travel.drafts.name).where(req.params[0])
      .columns(travel => { travel.DraftAdministrativeData.InProcessByUser.as('InProcessByUser') } )
    // action called on active -> reject if draft exists
    // action called on draft -> reject if not own draft
    const isDraft = req.target.name.endsWith('.drafts')
    if (!isDraft && existingDraft || isDraft && existingDraft?.InProcessByUser !== req.user.id)
      throw req.reject(423, `The travel is locked by ${existingDraft.InProcessByUser}.`);
  })
  this.on (acceptTravel, req => UPDATE (req.subject) .with ({ TravelStatus_code: TravelStatusCode.Accepted }))
  this.on (rejectTravel, async req => {
    const { rejectionReason } = req.data
    await UPDATE (req.subject) .with ({
      TravelStatus_code: TravelStatusCode.Canceled,
      RejectionReason: rejectionReason ?? null
    })
  })
  this.on (submitForApproval, async req => {
    // 1. Load travel with related data
    const { TravelUUID } = req.params[0] as { TravelUUID: string }
    const travel = await SELECT.one (Travel)
      .where ({ TravelUUID })
      .columns (t => {
        t.TravelUUID, t.TravelID, t.Description,
        t.BeginDate, t.EndDate,
        t.BookingFee, t.TotalPrice, t.CurrencyCode_code.as('CurrencyCode'),
        t.GoGreen, t.TravelStatus_code,
        t.to_Customer(c => { c.FirstName, c.LastName }),
        t.to_Agency(a => { a.Name })
      })
    if (!travel) throw req.reject(400, 'Please save the travel before submitting for approval.')
    if (travel.TravelStatus_code !== TravelStatusCode.Open && travel.TravelStatus_code !== TravelStatusCode.Canceled)
      throw req.reject(400, `Travel cannot be submitted. Current status: ${travel.TravelStatus_code}`)

    // 2. Check for draft lock
    const existingDraft = await SELECT.one(Travel.drafts.name).where({ TravelUUID })
      .columns(t => { t.DraftAdministrativeData.InProcessByUser.as('InProcessByUser') })
    if (existingDraft)
      throw req.reject(423, `The travel is locked by ${existingDraft.InProcessByUser}.`)

    // 3. Call SBPA API to start workflow
    const sbpaDestination = process.env.SBPA_API_DESTINATION || 'sbpa-api'
    const definitionId = process.env.SBPA_PROCESS_DEFINITION_ID || 'us10.5f1bdb2btrial.sflighttravelapproval.travelApprovalProcess'
    const customerName = `${travel.to_Customer?.FirstName ?? ''} ${travel.to_Customer?.LastName ?? ''}`.trim()

    try {
      const dest = await getDestination({ destinationName: sbpaDestination }) as HttpDestination
      if (!dest) throw new Error(`Destination '${sbpaDestination}' not found.`)
      dest.forwardAuthToken = false  // force OAuth2ClientCredentials, ignore forwardAuthToken flag
      await executeHttpRequest(
        dest,
        {
          method: 'POST',
          url: '/workflow/rest/v1/workflow-instances',
          data: {
            definitionId,
            context: {
              travelUUID:     travel.TravelUUID,
              travelID:       travel.TravelID,
              description:    travel.Description ?? '',
              customerName,
              agencyName:     travel.to_Agency?.Name ?? '',
              beginDate:      travel.BeginDate,
              endDate:        travel.EndDate,
              totalPrice:     parseFloat(travel.TotalPrice as any),
              currencyCode:   travel.CurrencyCode,
              bookingFee:     parseFloat(travel.BookingFee as any),
              goGreen:        travel.GoGreen ?? false,
              processorEmail: req.user.id
            }
          }
        },
        { fetchCsrfToken: false }
      )
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : ''
      console.error('SBPA error response:', detail)
      throw req.reject(500, `Failed to start approval workflow: ${err.message} ${detail}`)
    }

    // 4. Update status to Pending
    await UPDATE (req.subject) .with ({ TravelStatus_code: TravelStatusCode.Pending })
    return SELECT (req.subject)
  })
  this.on (deductDiscount, async req => {
    let discount = req.data.percent / 100
    let succeeded = await UPDATE (req.subject) .where `TravelStatus.code != 'A'` .and `BookingFee != null`
      .with `TotalPrice = round (TotalPrice - TotalPrice * ${discount}, 3)`
      .with `BookingFee = round (BookingFee - BookingFee * ${discount}, 3)`

    if (!succeeded) { //> let's find out why...
      let travel = await SELECT.one `TravelID as ID, TravelStatus.code as status, BookingFee` .from (req.subject)
      if (!travel) throw req.reject (404, `Travel "${travel.ID}" does not exist; may have been deleted meanwhile.`)
      if (travel.status === TravelStatusCode.Accepted) throw req.reject (400, `Travel "${travel.ID}" has been approved already.`)
      if (travel.BookingFee == null) throw req.reject (404, `No discount possible, as travel "${travel.ID}" does not yet have a booking fee added.`)
    } else return SELECT(req.subject)
  })

  // Add base class's handlers. Handlers registered above go first.
  return super.init()

}}
