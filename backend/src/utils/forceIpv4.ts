/**
 * Force IPv4-first DNS resolution for all Node outbound connections.
 * Delta Exchange API key whitelist is IPv4-only (e.g. 169.58.123.144);
 * dual-stack hosts otherwise prefer IPv6 and get ip_not_whitelisted_for_api_key.
 */
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");
