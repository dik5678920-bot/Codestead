"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  plugins: [
    passkeyClient(),
    twoFactorClient({ twoFactorPage: "/two-factor" }),
    adminClient(),
  ],
});

export const { signIn, signOut, useSession } = authClient;
