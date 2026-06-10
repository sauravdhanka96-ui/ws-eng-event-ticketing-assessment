# Engineering Decisions - Event Ticketing Platform

## Problem Understanding

We are implementing two core features: Ticket Transfer and Event Waitlist.

1. **Ticket Transfer:** Confirmed tickets must be atomically transferred to an existing user via email. The transfer is immediate, revokes the original owner's access, updates the view, and requires robust error handling for invalid emails or cancelled tickets.
2. **Event Waitlist:** Sold-out events must allow users to join a chronological waitlist. If an existing ticket is cancelled, the first person on the waitlist must automatically be promoted to a confirmed booking. Users must also be able to leave the waitlist voluntarily.

## Approach

- **Data Modeling:** We will create a `WaitlistEntry` model in the Prisma schema with fields for `id`, `eventId`, `userId`, and `createdAt` (to preserve FIFO queuing). We will also ensure `BookingStatus` handles the state representation safely.
- **Atomic Transactions:** Both transferring a ticket and promoting a waitlisted user upon cancellation must be wrapped in strict database transactions (`prisma.$transaction`) to prevent data corruption or double-booking race conditions.
- **API Development:** Expose explicit REST endpoints for transferring, joining the waitlist, checking queue positioning, and leaving the waitlist.

## Risks & Assumptions

- **Race Conditions:** Multiple cancellations or rapid entries could cause race conditions. Using database transactions and strict timestamp filtering handles this natively.
- **Validation:** Assumed self-transfers are invalid and will throw a validation error.
