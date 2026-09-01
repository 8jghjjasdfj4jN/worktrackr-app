import React from 'react';

// Quiet build stamp (shown in the sidebar footer) so you can confirm a deploy
// went live. Inline + dim; it lives in the persistent sidebar, so it never
// flashes during navigation.
const AppVersion = () => {
  const APP_VERSION = '2026-09-01.follow-up-template';
  return (
    <div className="px-4 pb-2 text-[10px] text-[#6b7280] opacity-60 truncate select-none">
      Build {APP_VERSION}
    </div>
  );
};

export default AppVersion;
