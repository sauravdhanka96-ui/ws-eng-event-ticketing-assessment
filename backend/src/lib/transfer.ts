import { generateTicketCode, generateQRData } from "./qr.js";

/**
 * Transfers a booking from one user to another by marking the original
 * booking as transferred and creating a fresh confirmed booking for the
 * recipient inside the same transaction.
 *
 * This preserves a historical audit trail for the original attendee while
 * issuing brand-new ticket credentials to the recipient.
 *
 * @param tx - Prisma transaction client (call within $transaction)
 * @param bookingId - ID of the booking to transfer
 * @param recipientId - User ID of the new owner
 * @returns The newly created booking for the recipient
 */
export async function transferBooking(tx: any, bookingId: string, recipientId: string) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      event: true,
      seatTier: true,
    },
  });

  if (!booking) {
    throw new Error("NOT_FOUND:Booking not found");
  }

  if (booking.status !== "CONFIRMED") {
    throw new Error("INVALID_STATUS:Only confirmed bookings can be transferred");
  }

  if (booking.userId === recipientId) {
    throw new Error("SELF_TRANSFER:You cannot transfer a ticket to yourself");
  }

  const recipientExistingBooking = await tx.booking.findFirst({
    where: {
      userId: recipientId,
      eventId: booking.eventId,
      status: {
        in: ["CONFIRMED", "CHECKED_IN"],
      },
    },
  });

  if (recipientExistingBooking) {
    throw new Error("DUPLICATE:Recipient already has a ticket for this event");
  }

  await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: "TRANSFERRED",
      cancelledAt: new Date(),
      refundAmount: 0,
    },
  });

  const ticketCode = generateTicketCode();
  const qrCodeData = generateQRData(ticketCode);

  await tx.waitlistEntry.deleteMany({
    where: {
      eventId: booking.eventId,
      userId: recipientId,
    },
  });

  const newBooking = await tx.booking.create({
    data: {
      ticketCode,
      qrCodeData,
      userId: recipientId,
      eventId: booking.eventId,
      seatTierId: booking.seatTierId,
      promoCodeId: booking.promoCodeId,
      pricePaid: booking.pricePaid,
      discountAmount: booking.discountAmount,
      status: "CONFIRMED",
    },
    include: {
      event: {
        select: {
          id: true,
          name: true,
          date: true,
          time: true,
          venue: true,
        },
      },
      seatTier: {
        select: {
          id: true,
          name: true,
          price: true,
        },
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  return newBooking;
}
