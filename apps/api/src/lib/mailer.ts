import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(
    url: string,
    private from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Entwicklung: E-Mails nur ins Log schreiben. */
export class LogMailer implements Mailer {
  constructor(private log: (msg: string) => void) {}
  async send(mail: Mail): Promise<void> {
    this.log(`E-Mail an ${mail.to}: ${mail.subject}\n${mail.text}`);
  }
}

/** Tests: E-Mails sammeln. */
export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  last(to?: string): Mail | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}
