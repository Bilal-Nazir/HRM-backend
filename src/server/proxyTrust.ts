// The API is private to the Docker network. Only known local/private proxy
// hops may supply forwarding headers; a direct public client cannot do so.
export function trustProxyRanges(value = process.env.TRUST_PROXY_CIDRS): string[] | false {
  if (value === "false") return false;
  return (value === undefined ? "loopback,linklocal,uniquelocal" : value).split(",").map((range) => range.trim()).filter(Boolean);
}
