import { Injectable, type MessageEvent } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import type { WorkItemHsmEvent, WorkItemState } from "./types.js";

interface WorkItemStateChangedPayload {
  work_item_id: string;
  prev_state: WorkItemState;
  next_state: WorkItemState;
  event_type: WorkItemHsmEvent["type"];
  timestamp: string;
}

@Injectable()
export class GraphEventsService {
  private readonly eventSubject = new Subject<MessageEvent>();
  private nextEventId = 0;

  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.eventSubject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  emitWorkItemStateChanged(payload: WorkItemStateChangedPayload): void {
    this.eventSubject.next({
      type: "work_item_state_changed",
      id: `graph_evt_${++this.nextEventId}`,
      data: JSON.stringify({
        event_type: "work_item_state_changed",
        payload,
      }),
    });
  }
}
