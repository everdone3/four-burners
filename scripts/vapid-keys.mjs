// Makes the VAPID key pair that signs push notifications (run once): npm run vapid
// Writes supabase/functions/.env (git-ignored): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Upload it as
// the notify function's secrets (README > Notifications). The public key also goes in .env.production as
// VITE_VAPID_PUBLIC_KEY; it is public by design. Never commit the private key.
// Refuses to replace existing keys: new keys silently break every device's subscription until it re-subscribes.
// Pass --force to replace them anyway, and --subject=mailto:you@example.com to set the contact.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../supabase/functions/.env', import.meta.url));
const force = process.argv.includes('--force');
const subject = process.argv.find((a) => a.startsWith('--subject='))?.slice(10) || 'https://github.com/everdone3/four-burners';

if (existsSync(file) && /VAPID_PRIVATE_KEY=/.test(readFileSync(file, 'utf8')) && !force) {
  const pub = /VAPID_PUBLIC_KEY=(\S+)/.exec(readFileSync(file, 'utf8'))?.[1];
  console.log(`Keys already exist in ${file}.\nPublic key: ${pub}\n(--force replaces them; every device must then turn notifications on again.)`);
  process.exit(0);
}
if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error('--subject must start with mailto: or https://');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

writeFileSync(
  file,
  `# Secrets for the notify Edge Function. Git-ignored. Upload: README > Notifications.\n` +
    `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=${subject}\n`,
);
console.log(`Wrote ${file}\nPublic key (put in .env.production as VITE_VAPID_PUBLIC_KEY):\n${publicKey}`);
