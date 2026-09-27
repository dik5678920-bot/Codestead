import type { Metadata } from "next";

import { AccessRequestQueue } from "@/components/admin/access-request-queue";

export const metadata: Metadata = {
  title: "Access queue",
};

export default function AdminAccessPage() {
  return <AccessRequestQueue />;
}
