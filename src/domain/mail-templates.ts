// What the system writes to a person. Two messages, both about getting into the system: the welcome
// when an account is made, and a new password when one is reset. The wording follows the HR service's
// WELCOME template (verigence/hrmgmt, src/hrmgmt/message_templates.py): the person's name, the
// dealership, what they are, and the address to sign in at.
//
// A temporary password in an email is a weaker thing than a link that expires, and it is written here
// in one place so it can be replaced by one without touching the screens that send it. Until then the
// account it reaches must be replaced at first sign-in, which the system already enforces.

import type { Message } from "../lib/mailer";

export interface Welcome {
  name: string;
  dealership: string;
  roleLabel: string;
  mobile: string;
  password: string;
  signInUrl: string;
}

const SIGN_IN_NOTE = (url: string, mobile: string) =>
  `Sign in at ${url} with your mobile number ${mobile}.\n\nYou will be asked to replace this password the first time you sign in. Nobody at ${"Verigence"} can read it, so keep it until then and choose your own afterwards.`;

export function welcomeMail(w: Welcome): Message {
  return {
    to: "",
    subject: `Your ${w.dealership} sign-in for Verigence VINeeti`,
    body:
      `Dear ${w.name},\n\n` +
      `An account has been created for you at ${w.dealership} as ${w.roleLabel}.\n\n` +
      `Temporary password: ${w.password}\n\n` +
      SIGN_IN_NOTE(w.signInUrl, w.mobile) +
      `\n\nIf you were not expecting this, tell your System Admin and do not sign in.`,
  };
}

export function resetMail(w: Omit<Welcome, "roleLabel">): Message {
  return {
    to: "",
    subject: `A new password for your ${w.dealership} sign-in`,
    body:
      `Dear ${w.name},\n\n` +
      `Your password at ${w.dealership} has been reset by an administrator. Any session you had open has been signed out.\n\n` +
      `Temporary password: ${w.password}\n\n` +
      SIGN_IN_NOTE(w.signInUrl, w.mobile) +
      `\n\nIf you did not ask for this, tell your System Admin at once.`,
  };
}
