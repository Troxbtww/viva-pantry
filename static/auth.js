/* Passwordless personal login. This is inactive in the local Python preview. */
(() => {
  const config = window.VIVA_CLOUD_CONFIG || {};
  if (!config.url || !config.anonKey) {
    window.pantryCloudReady = Promise.resolve();
    return;
  }
  window.pantrySupabase = window.supabase.createClient(config.url, config.anonKey);
  const client = window.pantrySupabase;
  window.pantrySignOut = async () => { await client.auth.signOut(); location.reload(); };
  window.pantryCloudReady = new Promise(async (resolve, reject) => {
    let ready = false;
    const finish = () => { if (!ready) { ready = true; resolve(); } };
    client.auth.onAuthStateChange((_event, session) => { if (session) finish(); });
    const { data, error } = await client.auth.getSession();
    if (error) console.warn('Sign-in could not be restored. Please sign in again.');
    if (data?.session) { finish(); return; }
    const main = document.querySelector('#main');
    main.innerHTML = `<div class="page-heading"><div><div class="eyebrow">YOUR FOOD NOTEBOOK</div><h1>Your pantry, wherever you shop.</h1><p class="subtitle">Sign in to keep your food, labels, and weekly prices together.</p></div></div><section class="panel" style="max-width:520px"><h2>Open your private collection</h2><p class="section-note">We’ll email a sign-in link. Use the same email on your phone and computer.</p><form id="cloud-login"><label class="field"><span>Your email</span><input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label><button class="button primary" style="margin-top:20px" type="submit">Email me a sign-in link</button><p id="login-message" role="status" style="margin-top:18px"></p></form><p class="form-help">Your records are private to your account. The app uses free cloud storage.</p></section>`;
    main.querySelector('#cloud-login').addEventListener('submit', async event => {
      event.preventDefault();
      const button=event.target.querySelector('button');
      const message=main.querySelector('#login-message');
      button.disabled=true;
      const email=new FormData(event.target).get('email').trim();
      const redirectTo=new URL('./',location.href).href;
      const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo}});
      message.textContent=error?error.message:'Check your email for a sign-in link. You can close this page after opening the link.';
      button.disabled=false;
    });
  });
})();
