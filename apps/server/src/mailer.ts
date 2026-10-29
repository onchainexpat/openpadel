// Email goes through a Mailer. In development it is kept in memory and logged; the Resend
// mailer (the club's own domain) arrives with M1.
export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  private log: boolean;
  constructor(log = false) { this.log = log; }
  async send(mail: Mail) {
    this.sent.push(mail);
    if (this.log) console.log(`[mail] to ${mail.to}: ${mail.subject}`);
  }
  last(to: string): Mail | undefined { return [...this.sent].reverse().find((m) => m.to === to); }
}
