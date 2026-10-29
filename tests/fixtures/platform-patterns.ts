// Independently authored behavioral patterns; no copied vendor UI or live requests.
export function platformPattern(kind: 'F12' | 'F13') {
  const gh = kind === 'F12';
  return `<p>Owned ${kind} pattern, vendor resemblance is not compatibility evidence.</p>
<form id="${gh ? 'application_form' : 'application'}" class="${gh ? '' : 'application-form'}" aria-label="Job application">
<label>${gh ? 'First name' : 'Full name'}<input name="${gh ? 'first_name' : 'name'}" autocomplete="${gh ? 'given-name' : 'name'}" required></label>
${gh ? '<label>Last name<input name="last_name" autocomplete="family-name" required></label>' : ''}
<label>Email<input name="email" type="email" required></label>
<label>Phone<input name="phone" type="tel"></label>
<label>Willing to relocate<select id="native-choice"><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>
<div id="work-label">Work location</div><div role="listbox" aria-labelledby="work-label" aria-required="true" id="work"><div role="option" aria-selected="false" tabindex="0">Remote</div><div role="option" aria-selected="false" tabindex="0">Hybrid</div><div role="option" aria-selected="false" aria-disabled="true" tabindex="0">On-site</div></div>
<label>Send job updates<input type="checkbox" id="updates"></label><label>I certify my answers and consent to processing<input type="checkbox" required id="consent"></label>
<label>Gender<select><option value="">Choose</option><option>Prefer not to say</option></select></label>
<label>Explain a project tradeoff<textarea name="question_456" required></textarea></label>
<label>Resume PDF<input type="file" id="resume" name="resume" accept="application/pdf" required aria-describedby="upload-state"></label><p id="upload-state" role="status"></p>
<div role="combobox" aria-label="University search" tabindex="0">Search manually</div><label for="remote-picker">Portfolio remote picker</label><input type="file" id="remote-picker" hidden>
<div id="conditional-area"></div><p id="field-error"></p>
<button type="button" id="next">Next</button><button>Submit application</button><button type="button" id="accept">Accept</button>
</form><script>
fixture.choiceEvents=0;fixture.uploads=[];
const form=document.querySelector('form'),work=document.querySelector('#work'),email=document.querySelector('[name=email]');
for(const o of work.children)o.addEventListener('click',()=>{if(o.getAttribute('aria-disabled')==='true')return;fixture.choiceEvents++;for(const p of work.children)p.setAttribute('aria-selected',String(o===p));if(o.textContent==='Hybrid')setTimeout(()=>document.querySelector('#conditional-area').innerHTML='<label>Required office city<input name="city" required></label>',240)});
email.addEventListener('change',()=>{if(new URL(location.href).searchParams.has('reject'))setTimeout(()=>{email.setAttribute('aria-invalid','true');email.setAttribute('aria-errormessage','field-error');document.querySelector('#field-error').textContent='Email rejected by policy'},280)});
document.querySelector('#native-choice').addEventListener('change',e=>{if(e.target.value==='yes')setTimeout(()=>document.querySelector('#conditional-area').innerHTML='<label>Required relocation city<input name="city" required></label>',240)});
document.querySelector('#resume').addEventListener('change',async e=>{const f=e.target.files[0],status=document.querySelector('#upload-state');if(!f)return;if(f.type!=='application/pdf'||f.size>1024*1024){status.textContent='Upload rejected: size or type';return}const bytes=await f.arrayBuffer();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');if(fixture.uploads.includes(digest)){status.textContent='Duplicate blocked';return}fixture.uploads.push(digest);status.textContent='Uploading';await fetch('/pattern-upload',{method:'POST',body:bytes});setTimeout(()=>{status.textContent=new URL(location.href).searchParams.has('upload-reject')?'Upload failed after processing':'Attachment received';fixture.uploadState=status.textContent},300)});
for(const b of document.querySelectorAll('#next,#accept'))b.onclick=()=>fixture.finalizations++;
</script>`;
}
