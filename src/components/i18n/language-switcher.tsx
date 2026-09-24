"use client";

import { useRouter } from "next/navigation";
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { setLocale } from "@/server/actions/locale";
import { useLocale } from "./locale-provider";

export const LANGUAGE_CHOICES = [
  { label: "English", value: "en" },
  { label: "Deutsch", value: "de" },
  { label: "Use assigned language", value: null },
] as const;

export function LanguageSwitcher() {
  const router = useRouter();
  const { messages } = useLocale();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="min-h-12">{messages.language}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {LANGUAGE_CHOICES.map(({ value }) => {
          const label = value === "en" ? messages.english : value === "de" ? messages.german : messages.assignedLanguage;
          return (
            <DropdownMenuItem key={value ?? "assigned"} className="min-h-12" onSelect={() => {
              void setLocale(value).then(() => router.refresh());
            }}>
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
