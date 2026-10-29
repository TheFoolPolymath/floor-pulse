// Floor Pulse settings. This is the only file you edit to connect the app to your Google Sheet.
window.FP_CONFIG = {
  // LIVE MODE: fill BOTH lines below, then redeploy. People sign in with their Google account.
  API_URL: '',            // the Apps Script web app URL, ends in /exec
  GOOGLE_CLIENT_ID: '',   // from Google Cloud Console, ends in .apps.googleusercontent.com (same one as in Code.gs)

  // While API_URL is empty the app runs in DEMO MODE with made-up data and no sign-in.

  BRANCH: 'Mumbai Branch',   // shown under the app name in demo mode
  REFRESH_MIN: 5             // how often live mode re-reads the sheet
};
