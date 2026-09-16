"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { timeZoneLabel, timeZoneOptions } from "./timezones";

export interface TimeZoneSelectProps {
  id: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  className?: string;
}

export function TimeZoneSelect({ id, value, onChange, disabled, className }: TimeZoneSelectProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={cn("w-full px-3 text-base data-[size=default]:h-12 lg:text-sm", className)}>
        <SelectValue placeholder="Choose a time zone" />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-80">
        {timeZoneOptions(value).map((tz) => (
          <SelectItem key={tz} value={tz} className="min-h-12">
            {timeZoneLabel(tz)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
