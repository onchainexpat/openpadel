-- A place in a program that's never paid for doesn't stay taken (programs.ts, lapseUnpaidPlaces): the member is
-- reminded once, halfway through the hold, and then the place goes to the waitlist.
ALTER TABLE enrolment ADD COLUMN pay_reminded_at timestamptz;
