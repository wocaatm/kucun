import { useState } from 'react';
import { DatePicker, Selector } from 'antd-mobile';
import dayjs from 'dayjs';
import { useSession } from '../store';
import { money } from '../api';

export function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="date-field" onClick={() => setOpen(true)}>
        {value === dayjs().format('YYYY-MM-DD') ? `今天 ${value}` : value}
      </span>
      <DatePicker
        visible={open}
        onClose={() => setOpen(false)}
        value={dayjs(value).toDate()}
        max={new Date()}
        min={dayjs().subtract(3, 'year').toDate()}
        onConfirm={(d) => onChange(dayjs(d).format('YYYY-MM-DD'))}
      />
    </>
  );
}

export function AccountField({
  value,
  onChange,
  exclude,
  showBalance,
}: {
  value?: number;
  onChange: (v: number) => void;
  exclude?: number;
  showBalance?: boolean;
}) {
  const { meta } = useSession();
  const options = (meta?.accounts ?? [])
    .filter((a) => a.id !== exclude)
    .map((a) => ({
      label: a.name,
      value: a.id,
      description: showBalance ? money(a.balance) : undefined,
    }));
  return (
    <Selector
      className="account-selector"
      columns={3}
      options={options}
      value={value ? [value] : []}
      onChange={(v) => v[0] && onChange(v[0])}
    />
  );
}

export function ChipField({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <Selector
      columns={options.length > 4 ? 3 : options.length}
      options={options.map((o) => ({ label: o, value: o }))}
      value={value ? [value] : []}
      onChange={(v) => v[0] && onChange(v[0])}
    />
  );
}
