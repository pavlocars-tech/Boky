import { loadConfig } from "../config";
import { createDb, migrate } from "../db";
import { hashPassword } from "../lib/crypto";

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error("Aufruf: pnpm create-admin <email> <passwort (mind. 10 Zeichen)> [Name]");
  process.exit(1);
}
const sql = createDb(loadConfig().DATABASE_URL, 1);
await migrate(sql);
const hash = await hashPassword(password);
await sql`
  INSERT INTO users (email, password_hash, name, role, email_verified_at)
  VALUES (${email.toLowerCase()}, ${hash}, ${nameParts.join(" ") || "Admin"}, 'admin', now())
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'
  WHERE users.role = 'admin'
`;
console.log(`Admin ${email} angelegt bzw. Passwort gesetzt.`);
await sql.end();
