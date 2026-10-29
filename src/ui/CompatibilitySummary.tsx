import { adapterCapabilities } from '../adapters/schema';

export function CompatibilitySummary() {
  return <details><summary>Compatibility and evidence</summary>
    <p>Coverage is limited to independently authored owned fixtures in automated Chromium. Live vendor forms and Brave, Edge and Firefox runtime are unverified. Recognition needs application semantics as well as a bounded host/path; it never grants autofill authority.</p>
    <div className="compatibility-table" role="region" aria-label="Scrollable compatibility evidence" tabIndex={0}><table aria-label="Compatibility summary"><thead><tr><th>Platform / tier</th><th>Proven pattern subset</th><th>Manual limitations</th></tr></thead>
      <tbody>{Object.entries(adapterCapabilities).map(([id, c]) => <tr key={id}><th scope="row">{c.name} · {c.tier}</th><td>{c.supported}. Evidence: {c.fixtures}, adapter 1.0.0; owned fixtures only.</td><td>{c.manual.join('; ')}.</td></tr>)}</tbody>
    </table></div>
    <p>Google Forms response APIs provide read methods; applyr uses no respondent submission endpoint. Google upload questions require account sign-in and may restrict file count, type and size. Handle sign-in and Drive dialogs yourself. No ATS API credentials, private tenant APIs or automated Next/submission are used.</p>
  </details>;
}
