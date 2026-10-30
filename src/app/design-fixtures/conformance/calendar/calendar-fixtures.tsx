"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, DatePicker, type CalendarDayRange } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";

/** Actual controlled host primitives; dates are local day keys, not clock instants. */
export function CalendarConformanceFixtures() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (root.current) root.current.dataset.hydrated = "true";
  }, []);
  const [range, setRange] = useState<CalendarDayRange | null>({ from: "2026-05-15", to: "2026-05-18" });
  const [pickerRange, setPickerRange] = useState<CalendarDayRange | null>(null);
  const [single, setSingle] = useState<string | null>("2026-05-18");
  return <div ref={root} className="flex flex-col gap-6" data-calendar-fixture="root" data-hydrated="false">
    <section data-calendar-fixture="range"><Calendar mode="range" range={range} onRangeChange={setRange} today="2026-05-15" /></section>
    <section data-calendar-fixture="single"><Calendar value={single} onValueChange={setSingle} today="2026-05-15" /></section>
    <section data-calendar-fixture="range-picker"><DatePicker mode="range" range={pickerRange} onRangeChange={setPickerRange} today="2026-05-15" /></section>
    <section data-calendar-fixture="single-picker"><DatePicker value={single} onValueChange={setSingle} today="2026-05-15" /></section>
    <section data-calendar-fixture="input"><Input aria-label="Input chrome reference" value="May 18, 2026" readOnly /></section>
  </div>;
}
