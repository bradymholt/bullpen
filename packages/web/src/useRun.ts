import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { Approval, Run, RunEvent, SocketMessage } from "./types.ts";

/**
 * Replay-then-live: the socket asks for everything past the highest seq we
 * hold, so a reconnect resumes exactly where it stopped and a server restart
 * looks the same as a dropped tab.
 */
export function useRun(runId: string | null) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [partial, setPartial] = useState("");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!runId) return;
    let closed = false;
    seqRef.current = 0;
    setEvents([]);
    setPartial("");

    const loadApprovals = () => api.approvals(runId).then((a) => !closed && setApprovals(a));

    api.run(runId).then(({ run, events }) => {
      if (closed) return;
      setRun(run);
      setEvents(events);
      seqRef.current = events.at(-1)?.seq ?? 0;
    });
    setApprovals([]);
    void loadApprovals();

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", runId, sinceSeq: seqRef.current }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as SocketMessage;
      if (msg.type === "status") {
        setRun((r) => (r ? { ...r, status: msg.status } : r));
        return;
      }
      if (msg.type === "approval") {
        void loadApprovals();
        return;
      }
      if (msg.type !== "event" || msg.seq <= seqRef.current) return;
      if (msg.eventType === "approval.requested" || msg.eventType === "approval.decided") {
        void loadApprovals();
      }
      seqRef.current = msg.seq;

      if (msg.eventType === "stream_event") {
        const ev = msg.payload?.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          setPartial((p) => p + ev.delta.text);
        }
        return;
      }
      if (msg.eventType === "assistant") setPartial("");
      setEvents((prev) => [...prev, { seq: msg.seq, ts: msg.ts, type: msg.eventType, payload: msg.payload }]);
    };

    return () => {
      closed = true;
      ws.close();
    };
  }, [runId]);

  return { run, events, partial, approvals };
}
