import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { requireUserPage } from "@/server/context";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const { profile } = await requireUserPage();

  return (
    <PageHeader
      title="Dashboard"
      description={
        <>
          Signed in as <span className="font-semibold text-foreground">{profile.name || profile.email}</span>
          {" · "}
          {profile.role === "ADMIN" ? "Admin" : "Agent"}
        </>
      }
    />
  );
}
