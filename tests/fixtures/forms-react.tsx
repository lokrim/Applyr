import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function ControlledFixture() {
  const writes = location.search.includes('writes=1');
  const [name, setName] = useState(writes ? '' : 'Alex Prefilled');
  const [email, setEmail] = useState(writes ? '' : 'controlled@example.invalid');
  const [locationValue, setLocationValue] = useState(writes ? '' : 'Remote');
  const [relocation, setRelocation] = useState(false);
  const [version, setVersion] = useState(0);
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => { (window as unknown as { fixture: { accepted: unknown } }).fixture.accepted = { name, email, location: locationValue, relocation, options }; }, [name, email, locationValue, relocation, options]);
  useEffect(() => { const timer = setTimeout(() => setOptions(['Remote', 'Hybrid']), 280); return () => clearTimeout(timer); }, []);
  return <><form id="application" aria-label="Controlled application" key={version}>
    <label>Full name<input name="name" value={name} onChange={(e) => setName(e.target.value)} required /></label>
    <label>Email<input name="email" type="email" value={email} onChange={() => { setEmail(writes ? '' : 'controlled@example.invalid'); }} /></label>
    <label>Work location<select value={locationValue} onChange={(e) => setLocationValue(e.target.value)}>{writes && <option value="">Choose</option>}{options.map((option) => <option key={option}>{option}</option>)}</select></label>
    {writes && <label>Willing to relocate<input type="checkbox" checked={relocation} onChange={(e) => setRelocation(e.target.checked)} /></label>}
    <button>Submit application</button>
  </form><button id="rerender" onClick={() => setVersion((v) => v + 1)}>Rerender controlled form</button></>;
}
createRoot(document.getElementById('react-root')!).render(<ControlledFixture />);
