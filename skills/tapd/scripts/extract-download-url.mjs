let input = "";
for await (const chunk of process.stdin) input += chunk;

const value = JSON.parse(input).download_url;
if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
  throw new Error("missing or invalid HTTPS download_url");
}
const url = new URL(value);
if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
  throw new Error("missing or invalid HTTPS download_url");
}
process.stdout.write(`${value}\n`);
