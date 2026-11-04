import { createContext, useContext } from "react";
import type { ArthurClient } from "../client/arthur-client";

export const ArthurClientContext = createContext<ArthurClient | null>(null);

export function useArthurClient(): ArthurClient {
  const client = useContext(ArthurClientContext);
  if (!client) {
    throw new Error("useArthurClient must be used inside <ArthurProviders>");
  }
  return client;
}
