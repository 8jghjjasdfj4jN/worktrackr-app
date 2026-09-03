// web/client/src/app/src/components/dialConfirm.js
//
// Confirmation step before a click-to-dial call actually rings.
//
// WHY THIS EXISTS
// Phone numbers are links, so a stray click dials a prospect. That is a real
// cost: an accidental call to a company is a wasted first impression, and there
// is no way to take it back. One extra tap is cheap; a misdial is not.
//
// WHY IT IS NOT REACT
// Four call sites across three files (CompanyProfile, LeadsList,
// CompanyPipelineList) all need this. A React modal would mean modal state in
// every one of them, plus the sub-component rule to hold in each. An imperative
// promise-based helper keeps the change at each call site down to a single
// handler, and there is no state to get wrong.
//
// ⚠️ THE DIAL HAPPENS HERE, NOT IN THE CALLER.
// This is deliberate and it is the whole safety argument. Browsers hand a
// `tel:` URL to the softphone only when the navigation happens inside a real
// user gesture. Navigating synchronously inside the Call button's own click
// handler keeps it inside that gesture. Resolving the promise first and letting
// the caller navigate would push it into a microtask — which usually works,
// and "usually" is not good enough for the one thing that must never break.
//
// This supersedes the old rule in CompanyProfile.jsx, LeadsList.jsx and
// CompanyPipelineList.jsx that said never to preventDefault on a phone link.
// Those handlers now MUST preventDefault, because the dial has moved in here.

const Z_INDEX = 10000;

// Guards against a second modal if a click lands while one is already open.
let openDialog = null;

/**
 * Ask before dialling.
 *
 * @param {object}  opts
 * @param {string}  opts.phone  number as displayed, for the prompt
 * @param {string}  opts.href   the tel: URL to navigate to on confirm
 * @returns {Promise<boolean>}  true if the call was placed, false if cancelled
 *
 * The caller should log the call only when this resolves true — cancelling
 * must not count as an attempt.
 */
export function confirmDial({ phone, href }) {
  // No href means telHref() found no digits. Nothing to confirm.
  if (!href) return Promise.resolve(false);

  // Already asking. Ignore the second click rather than stacking dialogs.
  if (openDialog) return Promise.resolve(false);

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.style.cssText = `
      position:fixed; inset:0; z-index:${Z_INDEX};
      background:rgba(0,0,0,0.55);
      display:flex; align-items:center; justify-content:center;
      padding:16px;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background:#242438; border:1px solid #2e2e4a; border-radius:12px;
      padding:20px; width:100%; max-width:320px;
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
      box-shadow:0 18px 40px rgba(0,0,0,0.45);
    `;

    const title = document.createElement('div');
    title.textContent = 'Call this number?';
    title.style.cssText = 'font-size:15px;font-weight:600;color:#fff;margin-bottom:6px;';

    const number = document.createElement('div');
    number.textContent = phone || '';
    number.style.cssText = 'font-size:19px;font-weight:700;color:#f59e0b;margin-bottom:16px;word-break:break-all;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      flex:1; padding:10px; border-radius:8px; cursor:pointer;
      background:transparent; border:1px solid #2e2e4a; color:#94a3b8;
      font-size:14px; font-family:inherit;
    `;

    const callBtn = document.createElement('button');
    callBtn.type = 'button';
    callBtn.textContent = 'Call';
    callBtn.style.cssText = `
      flex:1; padding:10px; border-radius:8px; cursor:pointer;
      background:#f59e0b; border:none; color:#1a1a2e;
      font-size:14px; font-weight:600; font-family:inherit;
    `;

    let settled = false;

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      openDialog = null;
    }

    function cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }

    // Navigation is SYNCHRONOUS and happens before cleanup or resolve, so it
    // stays inside the button's own click gesture. See the note at the top.
    function place() {
      if (settled) return;
      settled = true;
      try {
        window.location.href = href;
      } catch {
        /* If the browser refuses the tel: handler there is nothing to do here;
           the caller still treats it as an attempt, which matches what the user
           asked for and what they saw happen. */
      }
      cleanup();
      resolve(true);
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      // Enter confirms, so a keyboard user can dial without reaching for the
      // mouse. The Call button holds focus, so this is what they expect.
      else if (e.key === 'Enter') { e.preventDefault(); place(); }
    }

    cancelBtn.addEventListener('click', cancel);
    callBtn.addEventListener('click', place);

    // Clicking the backdrop cancels — but only the backdrop itself, never a
    // click that started inside the box.
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) cancel(); });

    document.addEventListener('keydown', onKey, true);

    row.appendChild(cancelBtn);
    row.appendChild(callBtn);
    box.appendChild(title);
    box.appendChild(number);
    box.appendChild(row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    openDialog = backdrop;
    callBtn.focus();
  });
}
