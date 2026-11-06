import { createHmac, timingSafeEqual } from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppConfigService,
  DRIZZLE_DB,
  EfficaAwarenessEvent,
  EfficaEventDetails,
  ZoomApiService,
  AppLogger,
  ZoomNonRecurringMeetingVal,
  ZoomRecurringMeetingVal,
  ZoomRegistrationClosedVal,
} from '@indigo-server/core';
import { DrizzleDb } from '@/common/schema';
import {
  WebhookEventSource,
  WebhookLogStatus,
  ZoomEventName,
  ZoomOccurrenceData,
  ZoomWebhookBody,
  ZoomWebhookHeaders,
  ZoomWebhookObject,
  ZoomWebhookResult,
} from '../types/zoom-webhook.types';
import { UsersService } from '@/common';
import { SchedulingCreditService } from '@/app/v1/portal-salesforce/services/scheduling-credit.service';
import { RegistrationStatus, SeriesType } from '@/app/v1/kinnect-circles/types';
import { organization as organizationTable } from '@/common/schema/org';
import {
  event as efficaEvent,
  eventOccurrence as efficaEventOccurrence,
  eventRegistrant as efficaEventRegistrant,
  eventWebhookLog as webhookEventLog,
  efficaEventType,
} from '@/common/schema/event';

@Injectable()
export class ZoomWebhookService {
  private static readonly KC_PRODUCT_NAME = 'Kinnect Circles';
  private static readonly DEFAULT_ORG_NAME = 'Effica Health Clinic';
  private static organizationID = 0;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private configService: AppConfigService,
    private readonly zoomApiService: ZoomApiService,
    private readonly schedulingCreditService: SchedulingCreditService,
    private readonly userService: UsersService,
    private readonly logger: AppLogger,
  ) {}

  // ========================
  // MAIN WEBHOOK HANDLER
  // ========================
  async handleWebhook(body: ZoomWebhookBody, headers: ZoomWebhookHeaders): Promise<ZoomWebhookResult> {
    let logId: number | null = null;
    try {
      const rawBody = JSON.stringify(body);
      const eventName = body.event;

      logId = await this.createWebhookLog(eventName, body);

      const isVerified = this.isSignatureVerified(rawBody, headers.zoomSignature, headers.zoomTimestamp);

      if (!this.isAuthorized(headers.authHeader)) {
        await this.updateWebhookLog(logId, WebhookLogStatus.Unauthorized, 'Unauthorized request');
        return { statusCode: 401, body: 'Unauthorized request' };
      }

      if (!isVerified) {
        await this.updateWebhookLog(logId, WebhookLogStatus.Unverified, 'Unauthorized signature request');
        return { statusCode: 401, body: 'Unauthorized signature request' };
      }

      if (eventName === ZoomEventName.EndpointUrlValidation) {
        await this.updateWebhookLog(logId, WebhookLogStatus.Success, null);
        return this.handleUrlValidationEvent(body);
      }

      await Promise.all([this.getSetOrgId(logId), this.handleZoomEvent(eventName, body, logId), this.updateWebhookLog(logId, WebhookLogStatus.Success, null)]);
      return { statusCode: 200, body: 'Event received successfully' };
    } catch (error: unknown) {
      this.logger.error('handleWebhook error', { type: 'system', context: 'ZoomWebhookService', error: error as Error });
      await this.updateWebhookLog(logId, WebhookLogStatus.Failed, error instanceof Error ? error.message : String(error));
      return { statusCode: 500, body: 'Internal server error' };
    }
  }

  // ========================
  // AUTH & VERIFICATION
  // ========================
  private isAuthorized(authHeader?: string): boolean {
    return authHeader != null && authHeader === this.configService.zoomConfig.webhookHeaderValue;
  }

  private isSignatureVerified(rawBody: string, zoomSignature?: string, zoomTimestamp?: string): boolean {
    if (!zoomSignature || !zoomTimestamp) return false;

    const timestampMs = Number(zoomTimestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;

    const message = `v0:${zoomTimestamp}:${rawBody}`;
    const hash = createHmac('sha256', this.configService.zoomConfig.webhookSecretToken).update(message).digest('hex');
    const generatedSignature = `v0=${hash}`;

    const a = Buffer.from(generatedSignature);
    const b = Buffer.from(zoomSignature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private handleUrlValidationEvent(body: ZoomWebhookBody): ZoomWebhookResult {
    const plainToken = (body.payload as unknown as { plainToken: string }).plainToken;
    const encryptedToken = createHmac('sha256', this.configService.zoomConfig.webhookSecretToken).update(plainToken).digest('hex');

    return { statusCode: 200, body: { plainToken, encryptedToken }, headers: { 'Content-Type': 'application/json' } };
  }

  private async getSetOrgId(logId: number | null) {
    const [record] = await this.db.select().from(organizationTable).where(eq(organizationTable.organization, ZoomWebhookService.DEFAULT_ORG_NAME)).limit(1);
    if (!record) {
      const errorMessage = 'Default organization not found!';
      await this.updateWebhookLog(logId, WebhookLogStatus.Failed, errorMessage);
      throw new Error(errorMessage);
    }
    ZoomWebhookService.organizationID = record.organizationId;
  }

  // ========================
  // EVENT LOGGING
  // ========================
  private async createWebhookLog(eventType: string, body: ZoomWebhookBody): Promise<number | null> {
    try {
      const [row] = await this.db
        .insert(webhookEventLog)
        .values({
          eventWebhookLog: eventType,
          payload: body,
          eventSource: WebhookEventSource.Zoom,
          errorMessage: null,
          status: WebhookLogStatus.Processing,
          organizationId: ZoomWebhookService.organizationID,
        })
        .returning({ webhookEventLogId: webhookEventLog.eventWebhookLogId });

      return row?.webhookEventLogId ?? null;
    } catch (error: unknown) {
      this.logger.error('createWebhookLog error', { type: 'system', context: 'ZoomWebhookService', error: error as Error });
      return null;
    }
  }

  private async updateWebhookLog(logId: number | null, status: WebhookLogStatus, errorMessage: string | null) {
    if (!logId) return;
    try {
      await this.db.update(webhookEventLog).set({ status, errorMessage }).where(eq(webhookEventLog.eventWebhookLogId, logId));
    } catch (error: unknown) {
      this.logger.error('updateWebhookLog error', { type: 'system', context: 'ZoomWebhookService', error: error as Error });
    }
  }

  // ========================
  // EVENT ROUTER
  // ========================
  private async handleZoomEvent(eventName: string, body: ZoomWebhookBody, logId: number | null) {
    try {
      const eventNames: string[] = [ZoomEventName.MeetingCreated, ZoomEventName.MeetingDeleted, ZoomEventName.MeetingPermanentlyDeleted];
      if (!eventNames.includes(eventName)) await this.ensureEventDataExists(eventName, body);

      const zoomApiResponse = await this.prefetchZoomDetails(body, eventName);

      switch (eventName) {
        case ZoomEventName.MeetingCreated:
          return this.handleEventCreated(body, this.deriveEfficaEventType(eventName), zoomApiResponse);
        case ZoomEventName.MeetingUpdated:
          return this.handleEventUpdated(body, zoomApiResponse);
        case ZoomEventName.MeetingDeleted:
          return this.handleEventDeleted(body);
        case ZoomEventName.MeetingPermanentlyDeleted:
          return this.handleEventPermanentlyDeleted(body);
        case ZoomEventName.MeetingRecovered:
          return this.handleEventRecovered(body);
        case ZoomEventName.MeetingConvertedToWebinar:
          return this.handleEventTypeConverted(body, EfficaAwarenessEvent.ZoomWebinar);
        case ZoomEventName.MeetingRegistrationCreated:
          return this.handleRegistrationCreated(body);
        case ZoomEventName.MeetingRegistrationCancelled:
          return this.handleRegistrationStatusUpdate(body, RegistrationStatus.Deleted);
        case ZoomEventName.MeetingRegistrationApproved:
          return this.handleRegistrationStatusUpdate(body, RegistrationStatus.Registered);
        case ZoomEventName.MeetingRegistrationDenied:
          return this.handleRegistrationStatusUpdate(body, RegistrationStatus.Denied);
        case ZoomEventName.MeetingParticipantJoined:
          return this.handleParticipantJoined(body);
        default:
          this.logger.warn('Unhandled event type', { type: 'system', context: 'ZoomWebhookService', meta: { eventName } });
      }
    } catch (error: unknown) {
      this.logger.error('handleZoomEvent error', { type: 'system', context: 'ZoomWebhookService', error: error as Error, meta: { eventName } });
      await this.updateWebhookLog(logId, WebhookLogStatus.Failed, error instanceof Error ? error.message : String(error));
    }
  }

  // ========================
  // UTILITY METHODS
  // ========================
  private async prefetchZoomDetails(body: ZoomWebhookBody, eventType: string): Promise<EfficaEventDetails | null> {
    try {
      const isEventValid = eventType.startsWith('meeting.') || eventType.startsWith('webinar.');
      if (!isEventValid) return null;

      const obj = this.getPayloadObject(body);
      const eventId = this.getStringId(obj);
      if (!eventId) return null;

      const isMeeting = eventType.startsWith('meeting.');
      return isMeeting ? this.zoomApiService.getMeetingById(eventId) : this.zoomApiService.getWebinarById(eventId);
    } catch {
      return null;
    }
  }

  private getPayloadObject(body: ZoomWebhookBody): ZoomWebhookObject {
    return body.payload.object;
  }

  private getStringId(obj: ZoomWebhookObject): string | null {
    const idVal = obj.id;
    if (idVal == null) return null;
    if (typeof idVal === 'string') return idVal;
    return String(Math.trunc(idVal));
  }

  private deriveSeriesType(agenda: string | null | undefined): SeriesType {
    if (!agenda) return SeriesType.General;
    if (agenda.startsWith(SeriesType.SingleSession)) return SeriesType.SingleSession;
    if (agenda.startsWith(SeriesType.SeriesSession)) return SeriesType.SeriesSession;
    return SeriesType.General;
  }

  private mapZoomStatusToInternal(zoomStatus: string | null | undefined): RegistrationStatus {
    if (!zoomStatus) return RegistrationStatus.Registered;
    if (zoomStatus === 'pending') return RegistrationStatus.Pending;
    if (zoomStatus === 'denied') return RegistrationStatus.Denied;
    return RegistrationStatus.Registered;
  }

  private isParticipantEvent(eventType: string): boolean {
    return [
      ZoomEventName.MeetingRegistrationCreated,
      ZoomEventName.MeetingRegistrationCancelled,
      ZoomEventName.MeetingRegistrationApproved,
      ZoomEventName.MeetingRegistrationDenied,
      ZoomEventName.MeetingParticipantJoined,
    ].includes(eventType as ZoomEventName);
  }

  private deriveEfficaEventType(eventName: string): EfficaAwarenessEvent {
    return eventName.startsWith('webinar.') ? EfficaAwarenessEvent.ZoomWebinar : EfficaAwarenessEvent.ZoomMeeting;
  }

  private async resolveEventTypeId(eventType: EfficaAwarenessEvent): Promise<number> {
    const [record] = await this.db.select().from(efficaEventType).where(eq(efficaEventType.eventType, eventType)).limit(1);
    if (!record) throw new Error(`Event type '${eventType}' not found in effica_event_type table`);
    return record.eventTypeId;
  }

  // ========================
  // SHARED EVENT LOGIC
  // ========================
  private async handleEventCreated(body: ZoomWebhookBody, eventType: EfficaAwarenessEvent, zoomApiResponse: EfficaEventDetails | null) {
    const obj = this.getPayloadObject(body);
    const topic = obj.topic as string | undefined;
    if (!topic || topic.toLowerCase().includes('internal')) return;

    const eventId = this.getStringId(obj);
    if (!eventId) return;

    const meetingType = obj.type ?? ZoomNonRecurringMeetingVal;
    const isRecurring = meetingType === ZoomRecurringMeetingVal;
    const joinUrl = obj.join_url ?? '';

    const registrationUrl = zoomApiResponse?.registrationUrl;
    const agenda = zoomApiResponse?.agendaDescription;
    const isDeletedOrCancelled = false;
    const isRegistrationOpen = zoomApiResponse?.registrationRequired ?? true;

    await this.db.transaction(async tx => {
      const eventTypeId = await this.resolveEventTypeId(eventType);

      const [newEvent] = await tx
        .insert(efficaEvent)
        .values({
          eventCustomId: eventId,
          event: topic,
          eventTypeId: eventTypeId,
          description: agenda ?? null,
          eventUrl: joinUrl,
          eventRegistrationUrl: registrationUrl ?? null,
          seriesType: this.deriveSeriesType(agenda),
          isDeletedOrCancelled,
          isRecurring,
          isRegistrationOpen,
          organizationId: ZoomWebhookService.organizationID,
        })
        .returning({ efficaEventId: efficaEvent.eventId });

      if (!newEvent) return;

      // Create occurrences
      const occurrences = obj.occurrences;
      const duration = obj.duration ?? null;

      if (occurrences?.length) {
        await tx.insert(efficaEventOccurrence).values(
          occurrences.map(occ => ({
            occurrenceCustomId: String(occ.occurrence_id),
            eventId: newEvent.efficaEventId,
            durationInMinutes: occ.duration ?? duration ?? null,
            isDeletedOrCancelled: false,
            startDatetime: occ.start_time ?? new Date().toISOString(),
            organizationId: ZoomWebhookService.organizationID,
          })),
        );
      } else {
        await tx.insert(efficaEventOccurrence).values({
          occurrenceCustomId: eventId,
          eventId: newEvent.efficaEventId,
          durationInMinutes: duration,
          isDeletedOrCancelled: false,
          startDatetime: obj.start_time ?? new Date().toISOString(),
          organizationId: ZoomWebhookService.organizationID,
        });
      }
    });
  }

  private async handleEventUpdated(body: ZoomWebhookBody, zoomApiResponse: EfficaEventDetails | null) {
    const obj = this.getPayloadObject(body);
    const eventId = this.getStringId(obj);
    if (!eventId) return;

    const scope = body.payload.scope;
    const isSingleOccurrenceEdit = scope === 'single';

    await this.db.transaction(async tx => {
      const [existingEvent] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
      if (!existingEvent) return;

      if (isSingleOccurrenceEdit) {
        await this.updateSpecificOccurrence(existingEvent.eventId, obj);
        return;
      }

      // Series-level updates
      const updateValues: Record<string, unknown> = { updatedDatetime: new Date().toISOString() };

      if (obj.topic) updateValues.efficaEvent = obj.topic;
      if (obj.join_url) updateValues.eventUrl = obj.join_url;

      const typeChanged = obj.type != null;
      let newIsRecurring = existingEvent.isRecurring;
      if (typeChanged) {
        newIsRecurring = obj.type === ZoomRecurringMeetingVal;
        updateValues.isRecurring = newIsRecurring;
      }

      if (obj.settings?.approval_type != null) {
        updateValues.isRegistrationOpen = obj.settings.approval_type !== ZoomRegistrationClosedVal;
      }

      // Apply API details
      if (zoomApiResponse) {
        if (zoomApiResponse.registrationUrl) updateValues.eventRegistrationUrl = zoomApiResponse.registrationUrl;
        if (zoomApiResponse.agendaDescription) {
          updateValues.description = zoomApiResponse.agendaDescription;
          updateValues.seriesType = this.deriveSeriesType(zoomApiResponse.agendaDescription);
        }
      }

      await tx.update(efficaEvent).set(updateValues).where(eq(efficaEvent.eventId, existingEvent.eventId));

      // Handle occurrence changes
      const occurrences = obj.occurrences;

      if (occurrences?.length) {
        await this.syncOccurrences(existingEvent.eventId, occurrences);
      } else if (typeChanged && !newIsRecurring) {
        await this.collapseToSingleOccurrence(existingEvent.eventId, eventId, obj);
      } else if ((obj.start_time || obj.duration) && !newIsRecurring) {
        await this.updateSingleOccurrenceTime(existingEvent.eventId, obj.start_time, obj.duration);
      }
    });
  }

  private async handleEventDeleted(body: ZoomWebhookBody) {
    const obj = this.getPayloadObject(body);
    const eventId = this.getStringId(obj);
    if (!eventId) return;

    const operation = body.payload.operation;
    const isSingleOccurrenceDeletion = operation === 'single';

    await this.db.transaction(async tx => {
      if (isSingleOccurrenceDeletion) {
        const occurrences = obj.occurrences;
        if (!occurrences?.length) return;

        const occurrenceId = String(occurrences[0]?.occurrence_id);
        await tx
          .update(efficaEventOccurrence)
          .set({ isDeletedOrCancelled: true, updatedDatetime: new Date().toISOString() })
          .where(
            and(
              eq(efficaEventOccurrence.occurrenceCustomId, occurrenceId),
              eq(
                efficaEventOccurrence.eventId,
                (await tx.select({ id: efficaEvent.eventId }).from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1))[0]?.id ?? 0,
              ),
            ),
          );
      } else {
        const [event] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
        if (!event) return;

        await tx.update(efficaEvent).set({ isDeletedOrCancelled: true, updatedDatetime: new Date().toISOString() }).where(eq(efficaEvent.eventId, event.eventId));
        await tx
          .update(efficaEventOccurrence)
          .set({ isDeletedOrCancelled: true, updatedDatetime: new Date().toISOString() })
          .where(and(eq(efficaEventOccurrence.eventId, event.eventId), eq(efficaEventOccurrence.isDeletedOrCancelled, false)));
      }
    });
  }

  private async handleEventPermanentlyDeleted(body: ZoomWebhookBody) {
    const obj = this.getPayloadObject(body);
    const eventId = this.getStringId(obj);
    if (!eventId) return;

    const operation = body.payload.operation;
    const isSingleOccurrenceDeletion = operation === 'single';

    await this.db.transaction(async tx => {
      const [event] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
      if (!event) return;

      if (isSingleOccurrenceDeletion) {
        const occurrences = obj.occurrences;
        if (!occurrences?.length) return;

        const occurrenceId = String(occurrences[0]?.occurrence_id);
        const [occ] = await tx
          .select()
          .from(efficaEventOccurrence)
          .where(and(eq(efficaEventOccurrence.occurrenceCustomId, occurrenceId), eq(efficaEventOccurrence.eventId, event.eventId)))
          .limit(1);
        if (!occ) return;

        await tx
          .update(efficaEventRegistrant)
          .set({ status: RegistrationStatus.Deleted })
          .where(
            and(
              eq(efficaEventRegistrant.eventOccurrenceId, occ.eventOccurrenceId),
              eq(efficaEventRegistrant.eventId, event.eventId),
              inArray(efficaEventRegistrant.status, [RegistrationStatus.Registered, RegistrationStatus.Pending]),
            ),
          );
      } else {
        await tx
          .update(efficaEventRegistrant)
          .set({ status: RegistrationStatus.Deleted })
          .where(and(eq(efficaEventRegistrant.eventId, event.eventId), inArray(efficaEventRegistrant.status, [RegistrationStatus.Registered, RegistrationStatus.Pending])));
      }
    });
  }

  private async handleEventTypeConverted(body: ZoomWebhookBody, newType: EfficaAwarenessEvent) {
    const obj = this.getPayloadObject(body);
    const eventId = this.getStringId(obj);
    if (!eventId) return;

    await this.db.transaction(async tx => {
      const eventTypeId = await this.resolveEventTypeId(newType);
      await tx.update(efficaEvent).set({ eventTypeId: eventTypeId, updatedDatetime: new Date().toISOString() }).where(eq(efficaEvent.eventCustomId, eventId));
    });
  }

  private async handleEventRecovered(body: ZoomWebhookBody) {
    const obj = this.getPayloadObject(body);
    const eventId = this.getStringId(obj);
    if (!eventId) return;

    const operation = body.payload.operation;
    const isSingleOccurrenceRecovery = operation === 'single';

    await this.db.transaction(async tx => {
      if (isSingleOccurrenceRecovery) {
        const occurrences = obj.occurrences;
        if (!occurrences?.length) return;

        const occurrenceId = String(occurrences[0]?.occurrence_id);
        const [event] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
        if (!event) return;

        await tx
          .update(efficaEventOccurrence)
          .set({ isDeletedOrCancelled: false, updatedDatetime: new Date().toISOString() })
          .where(and(eq(efficaEventOccurrence.occurrenceCustomId, occurrenceId), eq(efficaEventOccurrence.eventId, event.eventId)));

        if (event.isDeletedOrCancelled) {
          await tx.update(efficaEvent).set({ isDeletedOrCancelled: false, updatedDatetime: new Date().toISOString() }).where(eq(efficaEvent.eventId, event.eventId));
        }
      } else {
        const [event] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
        if (!event) return;

        await tx.update(efficaEvent).set({ isDeletedOrCancelled: false, updatedDatetime: new Date().toISOString() }).where(eq(efficaEvent.eventId, event.eventId));
        await tx
          .update(efficaEventOccurrence)
          .set({ isDeletedOrCancelled: false, updatedDatetime: new Date().toISOString() })
          .where(and(eq(efficaEventOccurrence.eventId, event.eventId), eq(efficaEventOccurrence.isDeletedOrCancelled, true)));
      }
    });
  }

  // ========================
  // OCCURRENCE MANAGEMENT
  // ========================
  private async syncOccurrences(efficaEventId: number, incomingOccurrences: ZoomOccurrenceData[]) {
    await this.db.transaction(async tx => {
      const existingOccurrences = await tx.select().from(efficaEventOccurrence).where(eq(efficaEventOccurrence.eventId, efficaEventId));
      const existingByOccId = new Map(existingOccurrences.map(o => [o.occurrenceCustomId, o]));

      const incomingOccIds = new Set<string>();
      const toInsert: {
        occurrenceCustomId: string;
        eventId: number;
        durationInMinutes: number | null;
        isDeletedOrCancelled: boolean;
        startDatetime: string;
        organizationId: number;
      }[] = [];

      for (const occ of incomingOccurrences) {
        const occId = String(occ.occurrence_id);
        if (occ.status === 'cancelled') continue;
        incomingOccIds.add(occId);

        const existing = existingByOccId.get(occId);
        if (existing) {
          const updates: Record<string, unknown> = {};
          if (occ.start_time && occ.start_time !== existing.startDatetime) updates.startDatetime = occ.start_time;
          if (occ.duration != null && occ.duration !== existing.durationInMinutes) updates.durationInMinutes = occ.duration;
          if (Object.keys(updates).length) {
            updates.updatedDatetime = new Date().toISOString();
            await tx.update(efficaEventOccurrence).set(updates).where(eq(efficaEventOccurrence.eventOccurrenceId, existing.eventOccurrenceId));
          }
        } else {
          toInsert.push({
            occurrenceCustomId: occId,
            eventId: efficaEventId,
            durationInMinutes: occ.duration ?? null,
            isDeletedOrCancelled: false,
            startDatetime: occ.start_time ?? new Date().toISOString(),
            organizationId: ZoomWebhookService.organizationID,
          });
        }
      }

      // Mark removed occurrences and their registrants
      const removedOccurrences = existingOccurrences.filter(o => !incomingOccIds.has(o.occurrenceCustomId));
      if (removedOccurrences.length) {
        const removedIds = removedOccurrences.map(o => o.eventOccurrenceId);
        await tx.delete(efficaEventRegistrant).where(inArray(efficaEventRegistrant.eventOccurrenceId, removedIds));
        await tx.delete(efficaEventOccurrence).where(inArray(efficaEventOccurrence.eventOccurrenceId, removedIds));
      }

      if (toInsert.length) {
        await tx.insert(efficaEventOccurrence).values(toInsert);
      }
    });
  }

  private async collapseToSingleOccurrence(efficaEventId: number, eventCustomId: string, obj: ZoomWebhookObject) {
    await this.db.transaction(async tx => {
      const existingOccurrences = await tx.select().from(efficaEventOccurrence).where(eq(efficaEventOccurrence.eventId, efficaEventId));

      const newStartTime = obj.start_time ?? null;

      if (!existingOccurrences.length) {
        await tx.insert(efficaEventOccurrence).values({
          occurrenceCustomId: eventCustomId,
          eventId: efficaEventId,
          durationInMinutes: obj.duration ?? null,
          isDeletedOrCancelled: false,
          startDatetime: newStartTime ?? new Date().toISOString(),
          organizationId: ZoomWebhookService.organizationID,
        });
      } else {
        const kept = existingOccurrences[0];
        if (!kept) return;
        const updates: Record<string, unknown> = { occurrenceCustomId: eventCustomId, updatedDatetime: new Date().toISOString() };
        if (newStartTime) updates.startDatetime = newStartTime;
        await tx.update(efficaEventOccurrence).set(updates).where(eq(efficaEventOccurrence.eventOccurrenceId, kept.eventOccurrenceId));

        if (existingOccurrences.length > 1) {
          const toDeleteIds = existingOccurrences.slice(1).map(o => o.eventOccurrenceId);
          await tx.delete(efficaEventRegistrant).where(inArray(efficaEventRegistrant.eventOccurrenceId, toDeleteIds));
          await tx.delete(efficaEventOccurrence).where(inArray(efficaEventOccurrence.eventOccurrenceId, toDeleteIds));
        }
      }
    });
  }

  private async updateSpecificOccurrence(efficaEventId: number, obj: ZoomWebhookObject) {
    const occurrences = obj.occurrences;
    if (!occurrences?.length) return;

    const occId = String(occurrences[0]?.occurrence_id);
    await this.db.transaction(async tx => {
      const [existing] = await tx
        .select()
        .from(efficaEventOccurrence)
        .where(and(eq(efficaEventOccurrence.occurrenceCustomId, occId), eq(efficaEventOccurrence.eventId, efficaEventId)))
        .limit(1);
      if (!existing) return;

      const updates: Record<string, unknown> = {};
      if (obj.start_time) updates.startDatetime = obj.start_time;
      if (obj.duration != null) updates.durationInMinutes = obj.duration;

      if (Object.keys(updates).length) {
        updates.updatedDatetime = new Date().toISOString();
        await tx.update(efficaEventOccurrence).set(updates).where(eq(efficaEventOccurrence.eventOccurrenceId, existing.eventOccurrenceId));
      }
    });
  }

  private async updateSingleOccurrenceTime(efficaEventId: number, startTime?: string, duration?: number) {
    await this.db.transaction(async tx => {
      const [occ] = await tx.select().from(efficaEventOccurrence).where(eq(efficaEventOccurrence.eventId, efficaEventId)).limit(1);
      if (!occ) return;

      const updates: Record<string, unknown> = {};
      if (startTime) updates.startDatetime = startTime;
      if (duration != null) updates.durationInMinutes = duration;

      if (Object.keys(updates).length) {
        updates.updatedDatetime = new Date().toISOString();
        await tx.update(efficaEventOccurrence).set(updates).where(eq(efficaEventOccurrence.eventOccurrenceId, occ.eventOccurrenceId));
      }
    });
  }

  // ========================
  // PARTICIPANT MANAGEMENT
  // ========================
  private async handleRegistrationCreated(body: ZoomWebhookBody) {
    try {
      const obj = this.getPayloadObject(body);
      const eventId = this.getStringId(obj);
      if (!eventId) return;

      const registrant = obj.registrant;
      if (!registrant?.email) return;

      const registrantEmail = registrant.email;
      const isRecurring = obj.type === ZoomRecurringMeetingVal;
      let occurrenceId: string;

      if (isRecurring) {
        const occurrences = obj.occurrences;
        if (!occurrences?.length) return;
        occurrenceId = String(occurrences[0]?.occurrence_id);
      } else {
        occurrenceId = eventId;
      }

      await this.db.transaction(async tx => {
        const [event] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
        if (!event) return;

        const [occurrence] = await tx
          .select()
          .from(efficaEventOccurrence)
          .where(and(eq(efficaEventOccurrence.occurrenceCustomId, occurrenceId), eq(efficaEventOccurrence.eventId, event.eventId)))
          .limit(1);
        if (!occurrence) return;

        // Check duplicate
        const [existing] = await tx
          .select()
          .from(efficaEventRegistrant)
          .where(
            and(
              eq(efficaEventRegistrant.eventOccurrenceId, occurrence.eventOccurrenceId),
              eq(efficaEventRegistrant.eventId, event.eventId),
              eq(efficaEventRegistrant.email, registrantEmail),
            ),
          )
          .limit(1);
        if (existing) return;

        const status = registrant.status === 'pending' || !registrant.join_url ? RegistrationStatus.Pending : RegistrationStatus.Registered;
        const userId = await this.getUserIdByEmail(registrantEmail);

        await tx.insert(efficaEventRegistrant).values({
          registrantCustomId: registrant.id ?? `${eventId}_${occurrenceId}_${registrantEmail}`,
          eventId: event.eventId,
          eventOccurrenceId: occurrence.eventOccurrenceId,
          email: registrantEmail,
          firstName: registrant.first_name ?? '',
          lastName: registrant.last_name ?? '',
          eventJoinUrl: registrant.join_url ?? '',
          status,
          organizationId: ZoomWebhookService.organizationID,
          organizationUserId: userId,
        });

        await this.schedulingCreditService.debitProduct([registrantEmail], ZoomWebhookService.KC_PRODUCT_NAME);
      });
    } catch (error: unknown) {
      this.logger.error('handleRegistrationCreated error', { type: 'system', context: 'ZoomWebhookService', error: error as Error });
    }
  }

  private async handleRegistrationStatusUpdate(body: ZoomWebhookBody, status: RegistrationStatus) {
    const obj = this.getPayloadObject(body);
    const eventId = this.getStringId(obj);
    if (!eventId) return;

    const registrant = obj.registrant;
    if (!registrant) return;

    const isRecurring = obj.type === ZoomRecurringMeetingVal;
    let occurrenceId: string;

    if (isRecurring) {
      const occurrences = obj.occurrences;
      if (!occurrences?.length) return;
      occurrenceId = String(occurrences[0]?.occurrence_id);
    } else {
      occurrenceId = eventId;
    }

    await this.db.transaction(async tx => {
      const [event] = await tx.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);
      if (!event) return;

      const [occurrence] = await tx
        .select()
        .from(efficaEventOccurrence)
        .where(and(eq(efficaEventOccurrence.occurrenceCustomId, occurrenceId), eq(efficaEventOccurrence.eventId, event.eventId)))
        .limit(1);
      if (!occurrence) return;

      if (registrant.id) {
        const [existingReg] = await tx
          .select()
          .from(efficaEventRegistrant)
          .where(
            and(
              eq(efficaEventRegistrant.registrantCustomId, registrant.id),
              eq(efficaEventRegistrant.eventOccurrenceId, occurrence.eventOccurrenceId),
              eq(efficaEventRegistrant.eventId, event.eventId),
            ),
          )
          .limit(1);

        if (existingReg) {
          const updates: Record<string, unknown> = { status };
          if (registrant.join_url) updates.eventJoinUrl = registrant.join_url;
          await tx.update(efficaEventRegistrant).set(updates).where(eq(efficaEventRegistrant.eventRegistrantId, existingReg.eventRegistrantId));
          return;
        }
      }

      // Registrant not found - create from webhook data
      if (!registrant.email) return;
      const userId = await this.getUserIdByEmail(registrant.email);

      await tx.insert(efficaEventRegistrant).values({
        registrantCustomId: registrant.id ?? `${eventId}_${occurrenceId}_${registrant.email}`,
        eventId: event.eventId,
        eventOccurrenceId: occurrence.eventOccurrenceId,
        organizationUserId: userId,
        email: registrant.email,
        firstName: registrant.first_name ?? '',
        lastName: registrant.last_name ?? '',
        eventJoinUrl: registrant.join_url ?? '',
        status,
        organizationId: ZoomWebhookService.organizationID,
      });
    });
  }

  private async handleParticipantJoined(body: ZoomWebhookBody) {
    const obj = this.getPayloadObject(body);
    const participant = obj.participant;
    if (!participant?.id) return;

    await this.db.update(efficaEventRegistrant).set({ status: RegistrationStatus.Attended }).where(eq(efficaEventRegistrant.registrantCustomId, participant.id));
  }

  // ========================
  // SELF-HEALING LOGIC
  // ========================
  private async ensureEventDataExists(eventType: string, body: ZoomWebhookBody) {
    try {
      const obj = this.getPayloadObject(body);
      const eventId = this.getStringId(obj);
      if (!eventId) return;

      const efficaEventType = this.deriveEfficaEventType(eventType);
      const isMeeting = efficaEventType === EfficaAwarenessEvent.ZoomMeeting;

      const [event] = await this.db.select().from(efficaEvent).where(eq(efficaEvent.eventCustomId, eventId)).limit(1);

      if (!event) {
        await this.selfHealCreateFullEvent(eventId, efficaEventType);
        return;
      }

      // Check if relevant occurrence exists
      const occurrenceId = this.getRelevantOccurrenceId(obj, event.isRecurring, eventId);
      const existingOccurrences = await this.db.select().from(efficaEventOccurrence).where(eq(efficaEventOccurrence.eventId, event.eventId));

      let occurrenceFound = false;
      if (occurrenceId) {
        occurrenceFound = existingOccurrences.some(o => o.occurrenceCustomId === occurrenceId);
      } else {
        occurrenceFound = existingOccurrences.length > 0;
      }

      if (!occurrenceFound) {
        await this.selfHealSyncOccurrences(event.eventId, eventId, event.isRecurring, isMeeting);
        return;
      }

      if (this.isParticipantEvent(eventType) && occurrenceId) {
        await this.selfHealSyncParticipants(event.eventId, eventId, occurrenceId, event.isRecurring, isMeeting);
      }
    } catch (error: unknown) {
      this.logger.error('ensureEventDataExists error', { type: 'system', context: 'ZoomWebhookService', error: error as Error });
    }
  }

  private getRelevantOccurrenceId(obj: ZoomWebhookObject, isRecurring: boolean, eventId: string): string | null {
    if (obj.occurrences?.length) {
      return String(obj.occurrences[0]?.occurrence_id);
    }
    if (!isRecurring) return eventId;
    return null;
  }

  private async selfHealCreateFullEvent(eventId: string, eventType: EfficaAwarenessEvent) {
    const isMeeting = eventType === EfficaAwarenessEvent.ZoomMeeting;
    const meetingData = isMeeting ? await this.zoomApiService.getMeetingByIdFull(eventId) : await this.zoomApiService.getWebinarByIdFull(eventId);

    if (!meetingData) return;

    const topic = meetingData.topic;
    if (!topic || topic.toLowerCase().includes('internal')) return;

    const eventTypeId = await this.resolveEventTypeId(eventType);

    const agenda = meetingData.agendaDescription;
    const registrationUrl = meetingData.registrationUrl;
    const isRegistrationOpen = meetingData.registrationRequired;

    // Pre-fetch registrants before DB writes
    const occurrences = meetingData.occurrences;
    const occIdsForApi: string[] = [];
    if (meetingData.isRecurring && occurrences.length) {
      for (const occ of occurrences) {
        occIdsForApi.push(occ.stringOccurrenceId);
      }
    }

    const allRegistrantsByOcc = new Map<string, Record<string, unknown>[]>();
    if (meetingData.isRecurring && occIdsForApi.length) {
      const results = await Promise.all(
        occIdsForApi.map(async occId => {
          const registrations = await this.zoomApiService.getAllEventRegistrants({ isMeeting, eventId, occurrenceId: occId });
          return { occId, registrations };
        }),
      );
      for (const { occId, registrations } of results) {
        if (registrations.length) allRegistrantsByOcc.set(occId, registrations);
      }
    } else {
      const registrations = await this.zoomApiService.getAllEventRegistrants({ isMeeting, eventId });
      if (registrations.length) allRegistrantsByOcc.set(eventId, registrations);
    }

    // Create event
    await this.db.transaction(async tx => {
      const [newEvent] = await tx
        .insert(efficaEvent)
        .values({
          eventCustomId: eventId,
          event: topic,
          eventTypeId: eventTypeId,
          description: agenda ?? null,
          eventUrl: meetingData.joinUrl ?? '',
          eventRegistrationUrl: registrationUrl ?? null,
          seriesType: this.deriveSeriesType(agenda),
          isDeletedOrCancelled: false,
          isRecurring: meetingData.isRecurring,
          isRegistrationOpen,
          organizationId: ZoomWebhookService.organizationID,
        })
        .returning({ efficaEventId: efficaEvent.eventId });

      if (!newEvent) return;

      // Create occurrences
      const occInsertValues = occurrences.map(occ => ({
        occurrenceCustomId: occ.stringOccurrenceId,
        eventId: newEvent.efficaEventId,
        durationInMinutes: occ.duration,
        isDeletedOrCancelled: occ.status === 'deleted',
        startDatetime: occ.startTime,
        organizationId: ZoomWebhookService.organizationID,
      }));

      const insertedOccurrences = await tx
        .insert(efficaEventOccurrence)
        .values(occInsertValues)
        .returning({ efficaEventOccurrenceId: efficaEventOccurrence.eventOccurrenceId, occurrenceCustomId: efficaEventOccurrence.occurrenceCustomId });

      // Create registrants
      await Promise.all(
        insertedOccurrences.map(async occ => {
          const occKey = meetingData.isRecurring ? occ.occurrenceCustomId : eventId;
          const registrants = allRegistrantsByOcc.get(occKey);
          if (registrants?.length) {
            await this.createRegistrantsFromData(newEvent.efficaEventId, occ.efficaEventOccurrenceId, eventId, occ.occurrenceCustomId, registrants);
          }
        }),
      );
    });
  }

  private async selfHealSyncOccurrences(efficaEventId: number, eventId: string, isRecurring: boolean, isMeeting: boolean) {
    const meetingData = isMeeting ? await this.zoomApiService.getMeetingByIdFull(eventId) : await this.zoomApiService.getWebinarByIdFull(eventId);

    if (!meetingData) return;

    await this.db.transaction(async tx => {
      const existingOccurrences = await tx.select().from(efficaEventOccurrence).where(eq(efficaEventOccurrence.eventId, efficaEventId));
      const existingOccIds = new Set(existingOccurrences.map(o => o.occurrenceCustomId));

      const occurrences = meetingData.occurrences;

      // Pre-fetch registrants
      const allOccIdsForApi = occurrences.length ? occurrences.map(o => o.stringOccurrenceId) : [eventId];

      const allRegistrantsByOcc = new Map<string, Record<string, unknown>[]>();
      if (isRecurring) {
        for (const occId of allOccIdsForApi) {
          const registrations = await this.zoomApiService.getAllEventRegistrants({ isMeeting, eventId, occurrenceId: occId });
          if (registrations.length) allRegistrantsByOcc.set(occId, registrations);
        }
      } else {
        const registrations = await this.zoomApiService.getAllEventRegistrants({ isMeeting, eventId });
        if (registrations.length) allRegistrantsByOcc.set(eventId, registrations);
      }

      // Create missing occurrences
      const newOccValues: {
        occurrenceCustomId: string;
        eventId: number;
        durationInMinutes: number | null;
        isDeletedOrCancelled: boolean;
        startDatetime: string;
        organizationId: number;
      }[] = [];

      if (occurrences.length) {
        for (const occ of occurrences) {
          const occId = occ.stringOccurrenceId;
          if (existingOccIds.has(occId)) continue;
          newOccValues.push({
            occurrenceCustomId: occId,
            eventId: efficaEventId,
            durationInMinutes: occ.duration,
            isDeletedOrCancelled: occ.status === 'deleted',
            startDatetime: occ.startTime,
            organizationId: ZoomWebhookService.organizationID,
          });
        }
      } else if (!existingOccIds.has(eventId)) {
        newOccValues.push({
          occurrenceCustomId: eventId,
          eventId: efficaEventId,
          durationInMinutes: null,
          isDeletedOrCancelled: false,
          startDatetime: new Date().toISOString(),
          organizationId: ZoomWebhookService.organizationID,
        });
      }

      if (newOccValues.length) {
        await tx.insert(efficaEventOccurrence).values(newOccValues);
      }

      // Create registrants for all occurrences
      const allOccurrences = await tx.select().from(efficaEventOccurrence).where(eq(efficaEventOccurrence.eventId, efficaEventId));

      for (const occ of allOccurrences) {
        const occKey = isRecurring ? occ.occurrenceCustomId : eventId;
        const registrants = allRegistrantsByOcc.get(occKey);
        if (registrants?.length) {
          await this.createRegistrantsFromData(efficaEventId, occ.eventOccurrenceId, eventId, occ.occurrenceCustomId, registrants);
        }
      }
    });
  }

  private async selfHealSyncParticipants(efficaEventId: number, eventId: string, occurrenceId: string, isRecurring: boolean, isMeeting: boolean) {
    const [occ] = await this.db
      .select()
      .from(efficaEventOccurrence)
      .where(and(eq(efficaEventOccurrence.occurrenceCustomId, occurrenceId), eq(efficaEventOccurrence.eventId, efficaEventId)))
      .limit(1);
    if (!occ) return;

    const apiOccId = isRecurring ? occurrenceId : undefined;
    const registrants = await this.zoomApiService.getAllEventRegistrants({ isMeeting, eventId, occurrenceId: apiOccId });
    if (!registrants.length) return;

    await this.createRegistrantsFromData(efficaEventId, occ.eventOccurrenceId, eventId, occurrenceId, registrants);
  }

  private async createRegistrantsFromData(efficaEventId: number, occurrenceDbId: number, eventId: string, occurrenceId: string, registrants: Record<string, unknown>[]) {
    await this.db.transaction(async tx => {
      const existingRegistrations = await tx
        .select({ email: efficaEventRegistrant.email, registrantCustomId: efficaEventRegistrant.registrantCustomId })
        .from(efficaEventRegistrant)
        .where(and(eq(efficaEventRegistrant.eventOccurrenceId, occurrenceDbId), eq(efficaEventRegistrant.eventId, efficaEventId)));

      const existingEmails = new Set(existingRegistrations.map(r => r.email.toLowerCase()));
      const existingIds = new Set(existingRegistrations.map(r => r.registrantCustomId));

      // Filter registrants synchronously to preserve deduplication logic
      const filteredRegs: { reg: Record<string, unknown>; email: string; registrantId: string | undefined }[] = [];
      for (const reg of registrants) {
        const email = reg.email as string | undefined;
        const registrantId = reg.id as string | undefined;
        if (!email) continue;

        if (existingEmails.has(email.toLowerCase()) || (registrantId && existingIds.has(registrantId))) continue;

        existingEmails.add(email.toLowerCase());
        if (registrantId) existingIds.add(registrantId);
        filteredRegs.push({ reg, email, registrantId });
      }

      const toInsert = await Promise.all(
        filteredRegs.map(async ({ reg, email, registrantId }) => {
          const status = this.mapZoomStatusToInternal(reg.status as string | undefined);
          const joinUrl = (reg.join_url as string) ?? '';
          const userId = await this.getUserIdByEmail(email);

          return {
            registrantCustomId: registrantId ?? `${eventId}_${occurrenceId}_${email}`,
            eventId: efficaEventId,
            eventOccurrenceId: occurrenceDbId,
            organizationUserId: userId,
            email,
            firstName: (reg.first_name as string) ?? '',
            lastName: (reg.last_name as string) ?? '',
            eventJoinUrl: joinUrl,
            status,
            organizationId: ZoomWebhookService.organizationID,
          };
        }),
      );

      if (toInsert.length) {
        await tx.insert(efficaEventRegistrant).values(toInsert);
        await this.schedulingCreditService.debitProduct(
          toInsert.map(r => r.email),
          ZoomWebhookService.KC_PRODUCT_NAME,
        );
      }
    });
  }

  // ========================
  // OTHERS
  // ========================
  private async getUserIdByEmail(email: string): Promise<number | null> {
    try {
      const user = await this.userService.findOneByEmail(email);
      return user.userId;
    } catch {
      return null;
    }
  }
}
