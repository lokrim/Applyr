import type { ReactNode } from 'react';

type Fields = Record<string, Field>;
type Field = { label: string; required?: boolean } & (
  { type: 'text' } | { type: 'number' } | { type: 'boolean' } | { type: 'result' } |
  { type: 'enum'; options: string[] } |
  { type: 'object'; fields: Fields } |
  { type: 'array'; item: Field; initial?: () => unknown }
);
const text = (label: string, required = false): Field => ({ type: 'text', label, required });
const object = (label: string, fields: Fields): Field => ({ type: 'object', label, fields });
const array = (label: string, item: Field, initial?: () => unknown): Field => ({ type: 'array', label, item, initial });
const strings = (label: string) => array(label, text('Text', true));
const bool = (label: string): Field => ({ type: 'boolean', label });
const number = (label: string): Field => ({ type: 'number', label });
const enumeration = (label: string, options: string[], required = false): Field => ({ type: 'enum', label, options, required });
const dates = { start_date: text('Start date'), end_date: text('End date') };
const stableId = text('Stable ID', true);
const initialId = (prefix: string) => () => ({ id: `${prefix}-${crypto.randomUUID().slice(0, 8)}` });

export const profileFields: Fields = {
  reviewed_on: text('Profile reviewed on'),
  identity: object('Identity', { legal_name: text('Legal name'), preferred_name: text('Preferred name'), given_name: text('Given name'), middle_name: text('Middle name'), family_name: text('Family name') }),
  contact: object('Contact', { email: text('Email'), phone: text('Phone'), address: object('Address', { line1: text('Address line 1'), line2: text('Address line 2'), city: text('City'), region: text('Region'), postal_code: text('Postal code'), country_code: text('Address country code') }) }),
  links: object('Links', { linkedin: text('LinkedIn'), github: text('GitHub'), portfolio: text('Portfolio'), website: text('Website'), other: array('Other links', object('Link', { label: text('Label'), url: text('URL') })) }),
  education: array('Education', object('Education record', { id: stableId, institution: text('Institution'), degree: text('Degree'), field: text('Field of study'), ...dates, expected: bool('Expected graduation'), result: object('Result', { value: { type: 'result', label: 'Result value' }, scale: { type: 'result', label: 'Result scale' } }), coursework: strings('Coursework'), certifications: strings('Certifications') }), initialId('education')),
  experience: array('Experience', object('Work record', { id: stableId, organization: text('Organization'), title: text('Title'), ...dates, current: bool('Current role'), responsibilities: strings('Responsibilities') }), initialId('experience')),
  projects: array('Projects', object('Project record', { id: stableId, name: text('Project name'), description: text('Description'), technologies: strings('Technologies'), achievements: strings('Achievements'), url: text('Project URL') }), initialId('project')),
  skills: array('Skills', object('Skill', { name: text('Skill name', true), evidence_refs: strings('Evidence references') }), () => ({ name: '' })),
  preferences: object('Preferences', { locations: strings('Locations'), work_arrangements: array('Work arrangements', enumeration('Arrangement', ['onsite', 'hybrid', 'remote'], true), () => 'onsite'), available_from: text('Available from'), internship_months: number('Internship months'), notice_days: number('Notice days'), relocation: bool('Relocation'), compensation: object('Compensation', { amount: number('Amount'), currency: text('Currency'), period: enumeration('Period', ['hour', 'month', 'year']) }) }),
  eligibility: array('Eligibility', object('Country eligibility', { country_code: text('Eligibility country code', true), work_authorized: bool('Work authorized'), sponsorship_required: bool('Sponsorship required'), confirmed_on: text('Confirmed on') }), () => ({ country_code: '' })),
  answers: array('Reusable answers', object('Answer metadata', { id: stableId, question: text('Question', true), kind: enumeration('Kind', ['verified', 'preference'], true), fact_refs: strings('Fact references'), reviewed_on: text('Answer reviewed on') }), () => ({ ...initialId('answer')(), question: '', kind: 'verified' })),
};

function initial(field: Field): unknown {
  if (field.type === 'object') return {};
  if (field.type === 'array') return [];
  if (field.type === 'boolean') return false;
  if (field.type === 'enum') return field.options[0];
  return '';
}

export function ProfileFields({ value, onChange }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  return <>{Object.entries(profileFields).map(([key, field]) => <details key={key} open={['identity', 'contact'].includes(key)} className="profile-section">
    <summary>{field.label}</summary>
    <FieldInput field={field} value={value[key]} path={key} onChange={(next) => {
      const updated = { ...value }; if (next === undefined) delete updated[key]; else updated[key] = next; onChange(updated);
    }} />
  </details>)}</>;
}

function FieldInput({ field, value, path, onChange }: { field: Field; value: unknown; path: string; onChange: (value: unknown) => void }) {
  const mode = value === undefined ? 'absent' : value === null ? 'null' : 'value';
  const inputId = `field-${path}`;
  if (field.type === 'boolean') return <div className="profile-field" data-path={path}><label htmlFor={inputId}>{field.label}</label><select id={inputId} value={mode === 'value' ? String(value) : mode} onChange={(e) => onChange(e.target.value === 'absent' ? undefined : e.target.value === 'null' ? null : e.target.value === 'true')}><option value="absent">Not supplied</option><option value="null">Unknown (null)</option><option value="true">Yes (true)</option><option value="false">No (false)</option></select></div>;
  let control: ReactNode;
  if (field.type === 'object') {
    const record = (value ?? {}) as Record<string, unknown>;
    control = <div className="field-children">{Object.entries(field.fields).map(([key, child]) => <FieldInput key={key} field={child} value={record[key]} path={`${path}.${key}`} onChange={(next) => {
      const updated = { ...record }; if (next === undefined) delete updated[key]; else updated[key] = next; onChange(updated);
    }} />)}</div>;
  } else if (field.type === 'array') {
    const values = (value ?? []) as unknown[];
    control = <div className="field-children">{values.map((item, i) => <div className="repeat-record" key={i}>
      <FieldInput field={{ ...field.item, required: true }} value={item} path={`${path}.${i}`} onChange={(next) => onChange(values.map((old, index) => index === i ? next : old))} />
      <button type="button" className="text-button" onClick={() => onChange(values.filter((_, index) => index !== i))}>Remove {field.label} item {i + 1}</button>
    </div>)}<button type="button" className="secondary" disabled={values.length >= 100} onClick={() => onChange([...values, field.initial?.() ?? initial(field.item)])}>Add {field.label} item</button></div>;
  } else if (field.type === 'enum') {
    control = <select id={inputId} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>{field.options.map((v) => <option key={v} value={v}>{v}</option>)}</select>;
  } else if (field.type === 'result') {
    control = <><select aria-label={`${field.label} type`} value={typeof value === 'number' ? 'number' : 'text'} onChange={(e) => onChange(e.target.value === 'number' ? 0 : String(value ?? ''))}><option value="text">Text</option><option value="number">Number</option></select><input id={inputId} type={typeof value === 'number' ? 'number' : 'text'} value={String(value ?? '')} onChange={(e) => onChange(typeof value === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} /></>;
  } else if (field.type === 'number') {
    control = <input id={inputId} type="number" min="0" value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  } else {
    control = <textarea id={inputId} rows={1} spellCheck={false} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
  return <div className="profile-field" data-path={path}>
    <div className="field-label"><label htmlFor={inputId}>{field.label}</label>{!field.required && <select aria-label={`${field.label} state`} value={mode} onChange={(e) => onChange(e.target.value === 'absent' ? undefined : e.target.value === 'null' ? null : initial(field))}>
      <option value="absent">Not supplied</option><option value="null">Unknown (null)</option><option value="value">Enter value</option>
    </select>}</div>
    {(mode === 'value' || field.required) && control}
  </div>;
}
