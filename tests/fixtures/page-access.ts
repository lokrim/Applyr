export const application = `<!doctype html><title>Engineer at Fictional — Application</title><h1>Engineer at Fictional</h1>
<form id="application"><label>Name<input name="name" value="existing-name"></label><label>Email<input name="email" type="email" value="existing@example.invalid"></label>
<input type="hidden" name="hidden-token" value="hidden-canary"><input name="otp" autocomplete="one-time-code" value="otp-canary" hidden>
<input type="password" value="password-canary" hidden><button>Submit application</button></form>
<form id="newsletter"><input name="email" value="newsletter-canary"></form><iframe title="unrelated advert" src="https://unrelated.applyr.test/ad"></iframe>`;

export const pageCases = [
  { name: 'application', html: application, classification: 'application' },
  { name: 'listing', html: '<title>Careers</title><h1>Open positions</h1><a href="/jobs/one">Engineer</a><form id="search"><input name="search"></form>', classification: 'listing' },
  { name: 'login', html: '<title>Sign in to apply</title><h1>Login</h1><form><input name="email"><input type="password" value="secret"><input autocomplete="one-time-code" value="1234"></form>', classification: 'login_challenge' },
  { name: 'challenge', html: '<title>Security challenge</title><h1>Verify your identity</h1>', classification: 'login_challenge' },
  { name: 'irrelevant', html: '<title>Fictional weather</title><h1>Weather forecast</h1><form id="newsletter"><input name="email"></form>', classification: 'irrelevant' },
  { name: 'uncertain', html: '<title>Apply to Fictional</title><h1>Application loads here</h1><div id="custom-widget"></div>', classification: 'uncertain' },
  { name: 'frame', html: '<title>Application at Fictional</title><h1>Apply here</h1><iframe title="Job application" src="https://embed.applyr.test/application?token=not-persisted"></iframe><iframe title="Advertisement" src="https://unrelated.applyr.test/ad"></iframe>', classification: 'uncertain' },
] as const;
