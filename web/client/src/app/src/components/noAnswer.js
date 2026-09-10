// web/client/src/app/src/components/noAnswer.js
//
// Shared "no answer → call back" helpers.
//
// Used by CompanyProfile.jsx (pressing the No answer button) and
// CompanyPipelineList.jsx (the No answer chip, the row wording and the sort).
// One copy rather than two, following the callLog.js precedent: duplicating
// date maths across two screens is exactly how they would end up disagreeing
// about when a call-back is due.
//
// ⚠️ Every date here is a LOCAL calendar date built from local getters, never
// toISOString().slice(0,10). The server runs UTC, so under BST a call-back set
// on a Thursday evening would come back reading as Wednesday.

// Owner's rule: call back after 3 WORKING days, Mon–Fri.
// Thursday + 3 working days = the following Tuesday (Fri, Mon, Tue) — the
// weekend is skipped rather than counted.
export const WORKING_DAYS_AHEAD = 3;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// yyyy-mm-dd from a Date, using LOCAL getters
export function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayKey() {
  return localDateKey(new Date());
}

// yyyy-mm-dd → Date (local midnight). Returns null on anything unparseable so
// a bad stored value can never crash the list.
export function keyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? d : null;
}

// Step forward one day at a time, only counting Mon–Fri.
export function addWorkingDays(from, n) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let left = Math.max(0, n);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

export function callBackDueKey() {
  return localDateKey(addWorkingDays(new Date(), WORKING_DAYS_AHEAD));
}

// whole days from a → b, positive when b is later
function dayDiff(aKey, bKey) {
  const a = keyToDate(aKey);
  const b = keyToDate(bKey);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// A company is waiting on a call-back when a USABLE due date is set. The count
// on its own is history and must never be enough to put a company back on the
// list.
//
// The date must actually parse: a corrupt value would otherwise pin a company
// on the list permanently, with no due wording and never becoming ready. Better
// that it falls back into the normal stage lists where it can still be worked.
export function isAwaitingCallBack(co) {
  return keyToDate(co && co.crm ? co.crm.noAnswerDue : null) !== null;
}

export function noAnswerCount(co) {
  const n = Number(co && co.crm ? co.crm.noAnswerCount : 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Calendar days until the call-back: negative = overdue, 0 = today.
// Returns null when there is no usable date, so callers can skip the row.
//
// ⚠️ CALENDAR days, not working days. A no answer pressed on a Friday is due
// the following Wednesday — 3 working days, but 5 calendar days — so this can
// legitimately return up to 5.
export function daysUntilDue(co) {
  return dayDiff(todayKey(), co && co.crm ? co.crm.noAnswerDue : null);
}

// true once the call-back date has arrived (or passed)
export function isDue(co) {
  const diff = dayDiff(todayKey(), co && co.crm ? co.crm.noAnswerDue : null);
  return diff !== null && diff <= 0;
}

// Plain words, no jargon: "ready 9 days ago", "ready today", "in 2 days".
export function dueLabel(co) {
  const due = co && co.crm ? co.crm.noAnswerDue : null;
  if (!due) return '';
  const diff = dayDiff(todayKey(), due);
  if (diff === null) return '';
  if (diff < 0) return diff === -1 ? 'ready since yesterday' : `ready ${Math.abs(diff)} days ago`;
  if (diff === 0) return 'ready today';
  return diff === 1 ? 'in 1 day' : `in ${diff} days`;
}

// "3 no answers · last tried 28 Aug"
export function attemptLabel(co) {
  const n = noAnswerCount(co);
  const bits = [];
  if (n > 0) bits.push(n === 1 ? '1 no answer' : `${n} no answers`);
  const d = keyToDate(co && co.crm ? co.crm.noAnswerLast : null);
  if (d) bits.push(`last tried ${d.getDate()} ${MONTHS[d.getMonth()]}`);
  return bits.join(' · ');
}

// What to write when No answer is pressed: one more attempt, tried today,
// call back in 3 working days.
export function noAnswerPatch(co) {
  return {
    noAnswerCount: noAnswerCount(co) + 1,
    noAnswerLast: todayKey(),
    noAnswerDue: callBackDueKey(),
  };
}

// What takes a company OFF the list. The count is deliberately kept, so the
// history of how many times they didn't answer survives getting through.
export const CLEAR_CALL_BACK = { noAnswerDue: null };

// Oldest due first, so the most overdue call-backs sit at the top.
export function byDueSoonest(a, b) {
  const ak = (a && a.crm && a.crm.noAnswerDue) || '9999-12-31';
  const bk = (b && b.crm && b.crm.noAnswerDue) || '9999-12-31';
  if (ak < bk) return -1;
  if (ak > bk) return 1;
  return 0;
}
