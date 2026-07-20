// token-utils.js
// Shared "definitive queue" logic for the clinic's token system.
//
// Both online bookings (appointment.html) and walk-in check-ins (create.html)
// share ONE token sequence per service + date. A token is not just an
// incrementing counter — it always reflects true chronological order by
// appointment_time, so a walk-in who checks in for an earlier open slot than
// an already-booked online patient correctly slots in ahead of them, and
// everyone after gets renumbered.
//
// reassignDailyTokens() is the single source of truth: call it after any
// create, reschedule, or delete that touches a given service+date, and it
// recomputes token_number for every appointment in that group in one batch.

import {
    collection,
    query,
    where,
    getDocs,
    writeBatch,
    doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/**
 * Recomputes and persists token_number for every active appointment on a
 * given service + date, ordered by appointment_time (createdAt as a
 * tiebreaker for identical times). Returns the freshly-ordered list so the
 * caller can immediately know where a specific record landed, without a
 * second read.
 *
 * @param {Firestore} db
 * @param {string} serviceType
 * @param {string} appointmentDate  (YYYY-MM-DD)
 * @returns {Promise<Array<{id:string, token_number:number, appointment_time:string, status:string, entry_source:string, patient_name:string}>>}
 */
export async function reassignDailyTokens(db, serviceType, appointmentDate) {
    const q = query(
        collection(db, "appointments"),
        where("service_type", "==", serviceType),
        where("appointment_date", "==", appointmentDate)
    );
    const snap = await getDocs(q);

    const entries = [];
    snap.forEach(docSnap => {
        const data = docSnap.data();
        if (data.entry_kind === 'session_log') return; // not a queue slot
        if (!data.appointment_time) return;

        entries.push({
            id: docSnap.id,
            appointment_time: data.appointment_time,
            status: data.status || 'Booked',
            entry_source: data.entry_source || 'online',
            patient_name: data.patient_name || '',
            createdMs: data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : 0,
            prevToken: data.token_number || null
        });
    });

    entries.sort((a, b) => {
        if (a.appointment_time !== b.appointment_time) {
            return a.appointment_time < b.appointment_time ? -1 : 1;
        }
        return a.createdMs - b.createdMs;
    });

    const batch = writeBatch(db);
    let pendingWrites = 0;

    entries.forEach((entry, idx) => {
        const newToken = idx + 1;
        entry.token_number = newToken;
        if (entry.prevToken !== newToken) {
            batch.update(doc(db, "appointments", entry.id), { token_number: newToken });
            pendingWrites++;
        }
    });

    if (pendingWrites > 0) {
        await batch.commit();
    }

    return entries;
}

/**
 * Given the ordered entries returned by reassignDailyTokens, counts how many
 * patients ahead of the given entry are still waiting (not yet Visited).
 */
export function countStillWaitingAhead(entries, entryId) {
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx === -1) return 0;
    return entries.slice(0, idx).filter(e => e.status !== 'Visited').length;
}