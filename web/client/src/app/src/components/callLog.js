// Records one call when a phone number is clicked to dial.
//
// Shared by CompanyPipelineList.jsx, LeadsList.jsx and CompanyProfile.jsx.
// Unlike telHref (a pure string function, duplicated per file to match the
// existing pattern), this makes a network call and fires an event — three
// copies of that would be genuinely worse than one import.
//
// Owner's rule: EVERY click counts, including clicking the same number again.
// There is deliberately NO de-duplication here or on the server — a redial
// after no answer is a real second attempt.
//
// ⚠️ This must NEVER interfere with actually placing the call. It is called
// from an <a href="tel:..."> onClick that does NOT preventDefault, so the
// browser hands the number to the softphone whatever happens here:
//   • the request is fire-and-forget — nothing is awaited before the dial
//   • `keepalive` lets it complete even though clicking a tel: link may hand
//     focus to another application
//   • every failure is swallowed; a lost count is a far smaller problem than
//     a call that doesn't ring
export const CALL_LOGGED_EVENT = 'worktrackr:call-logged';

export function logCall({ contactId = null, phone = null } = {}) {
  try {
    fetch('/api/contacts/call-log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, phone }),
      keepalive: true,
    })
      .then(() => {
        // Tell any counter on screen to refresh so the number moves straight
        // away, rather than only on the next page load.
        try { window.dispatchEvent(new CustomEvent(CALL_LOGGED_EVENT)); } catch { /* ignore */ }
      })
      .catch(() => { /* never block the dial */ });
  } catch {
    /* never block the dial */
  }
}
