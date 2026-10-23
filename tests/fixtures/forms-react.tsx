import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function ControlledFixture() {
  const [name, setName] = useState('Alex Prefilled');
  const [version, setVersion] = useState(0);
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => { (window as unknown as { fixture: { accepted: unknown } }).fixture.accepted = { name, email: 'controlled@example.invalid', options }; }, [name, options]);
  useEffect(() => { const timer = setTimeout(() => setOptions(['Remote', 'Hybrid']), 280); return () => clearTimeout(timer); }, []);
  return <><form id="application" aria-label="Controlled application" key={version}>
    <label>Full name<input name="name" value={name} onChange={(e) => setName(e.target.value)} required /></label>
    <label>Email<input name="email" type="email" value="controlled@example.invalid" onChange={() => { /* Deliberately reject edits. */ }} /></label>
    <label>Work location<select value="Remote" onChange={() => {}}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>
    <button>Submit application</button>
  </form><button id="rerender" onClick={() => setVersion((v) => v + 1)}>Rerender controlled form</button></>;
}
createRoot(document.getElementById('react-root')!).render(<ControlledFixture />);
