import type { Metadata } from "next";

import { AdminOverview } from "@/components/admin/admin-overview";

export const metadata: Metadata = {
  title: "Operations console",
  description: "Private administrator operations and learner mentor overview.",
};

export default function AdminPage() {
  return <AdminOverview />;
}
