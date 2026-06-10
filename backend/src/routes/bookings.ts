import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { createBookingSchema, reassignBookingSchema } from "../lib/validations.js";
import { authenticate } from "../middleware/auth.js";
import { generateTicketCode, generateQRData, generateQRCodeDataURL } from "../lib/qr.js";
import { calculateRefund } from "../lib/refund.js";
import { incrementCapacity, decrementCapacity } from "../lib/capacity.js";
import { transferBooking } from "../lib/transfer.js";

const router = Router();

async function promoteNextWaitlistedUser(tx: any, cancelledBooking: any) {
  const waitlistEntries = await tx.waitlistEntry.findMany({
    where: {
      eventId: cancelledBooking.eventId,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const entry of waitlistEntries) {
    const existingActiveBooking = await tx.booking.findFirst({
      where: {
        userId: entry.userId,
        eventId: cancelledBooking.eventId,
        status: {
          in: ["CONFIRMED", "CHECKED_IN"],
        },
      },
    });

    if (existingActiveBooking) {
      await tx.waitlistEntry.delete({
        where: { id: entry.id },
      });
      continue;
    }

    const ticketCode = generateTicketCode();
    const qrCodeData = generateQRData(ticketCode);

    await incrementCapacity(tx, cancelledBooking.eventId, cancelledBooking.seatTierId);

    const promotedBooking = await tx.booking.create({
      data: {
        ticketCode,
        qrCodeData,
        userId: entry.userId,
        eventId: cancelledBooking.eventId,
        seatTierId: cancelledBooking.seatTierId,
        promoCodeId: null,
        pricePaid: cancelledBooking.seatTier?.price ?? cancelledBooking.event.price,
        discountAmount: 0,
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

    await tx.waitlistEntry.delete({
      where: { id: entry.id },
    });

    return promotedBooking;
  }

  return null;
}

// GET /api/bookings - List user's bookings
router.get("/", authenticate, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        userId: req.user!.userId,
        status: {
          not: "TRANSFERRED",
        },
      },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            time: true,
            venue: true,
            imageUrl: true,
            status: true,
            category: true,
          },
        },
        seatTier: {
          select: {
            id: true,
            name: true,
            price: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to fetch bookings",
    });
  }
});

// GET /api/bookings/:id - Get booking details
router.get("/:id", authenticate, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id as string },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            time: true,
            venue: true,
            imageUrl: true,
            artistInfo: true,
            status: true,
            category: true,
            refundPolicy: true,
            serviceFeePercent: true,
          },
        },
        seatTier: {
          select: {
            id: true,
            name: true,
            price: true,
          },
        },
        promoCode: {
          select: {
            id: true,
            code: true,
            discountType: true,
            discountValue: true,
          },
        },
      },
    });

    if (!booking || booking.status === "TRANSFERRED") {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "Booking not found",
      });
    }

    if (booking.userId !== req.user!.userId) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: "You can only view your own bookings",
      });
    }

    res.json({ success: true, data: booking });
  } catch (error) {
    console.error("Error fetching booking:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to fetch booking",
    });
  }
});

// GET /api/bookings/:id/refund-preview - Calculate refund breakdown before cancellation
router.get("/:id/refund-preview", authenticate, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id as string },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            refundPolicy: true,
            serviceFeePercent: true,
          },
        },
      },
    });

    if (!booking || booking.status === "TRANSFERRED") {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "Booking not found",
      });
    }

    if (booking.userId !== req.user!.userId) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: "You can only view refund details for your own bookings",
      });
    }

    if (booking.status !== "CONFIRMED") {
      return res.status(400).json({
        success: false,
        error: "INVALID_STATUS",
        message:
          booking.status === "CANCELLED"
            ? "This booking has already been cancelled"
            : "Only confirmed bookings can be cancelled",
      });
    }

    const refund = calculateRefund(
      booking.pricePaid,
      new Date(booking.event.date),
      booking.event.refundPolicy,
      booking.event.serviceFeePercent
    );

    res.json({
      success: true,
      data: refund,
    });
  } catch (error) {
    console.error("Error calculating refund preview:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to calculate refund preview",
    });
  }
});

// POST /api/bookings - Create booking (buy ticket)
router.post("/", authenticate, async (req, res) => {
  try {
    const result = createBookingSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: result.error.errors[0].message,
      });
    }

    const { eventId, seatTierId, promoCode } = result.data;

    const booking = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        include: { seatTiers: true },
      });

      if (!event) {
        throw new Error("NOT_FOUND:Event not found");
      }

      if (event.status !== "PUBLISHED") {
        throw new Error("INVALID_EVENT:Event is not available for booking");
      }

      const existingBooking = await tx.booking.findFirst({
        where: {
          userId: req.user!.userId,
          eventId,
          status: "CONFIRMED",
        },
      });

      if (existingBooking) {
        throw new Error("DUPLICATE:You already have a ticket for this event");
      }

      let ticketPrice = event.price;
      let selectedTierId: string | null = null;

      if (event.seatTiers.length > 0) {
        if (!seatTierId) {
          throw new Error("VALIDATION:Please select a seat tier");
        }

        const tier = event.seatTiers.find((t) => t.id === seatTierId);
        if (!tier) {
          throw new Error("NOT_FOUND:Selected tier not found");
        }

        if (tier.soldCount >= tier.capacity) {
          throw new Error("SOLD_OUT:Selected tier is sold out");
        }

        ticketPrice = tier.price;
        selectedTierId = tier.id;
      } else if (event.soldCount >= event.capacity) {
        throw new Error("SOLD_OUT:Event is sold out");
      }

      await incrementCapacity(tx, eventId, selectedTierId);

      let discountAmount = 0;
      let appliedPromoId: string | null = null;

      if (promoCode) {
        const promo = await tx.promoCode.findUnique({
          where: { eventId_code: { eventId, code: promoCode.toUpperCase() } },
        });

        if (!promo || !promo.isActive) {
          throw new Error("INVALID_CODE:Invalid promo code");
        }

        if (promo.usageLimit && promo.usageCount >= promo.usageLimit) {
          throw new Error("CODE_EXHAUSTED:This code has reached its usage limit");
        }

        const now = new Date();
        if (promo.validFrom && now < new Date(promo.validFrom)) {
          throw new Error("INVALID_CODE:This promo code is not yet active");
        }
        if (promo.validUntil && now > new Date(promo.validUntil)) {
          throw new Error("INVALID_CODE:This promo code has expired");
        }

        if (promo.minPurchaseAmount && ticketPrice < promo.minPurchaseAmount) {
          throw new Error(
            `MIN_PURCHASE:Minimum purchase of $${promo.minPurchaseAmount.toFixed(2)} required for this code`
          );
        }

        if (promo.discountType === "PERCENTAGE") {
          discountAmount = ticketPrice * (promo.discountValue / 100);
          if (promo.maxDiscountAmount && discountAmount > promo.maxDiscountAmount) {
            discountAmount = promo.maxDiscountAmount;
          }
        } else {
          discountAmount = promo.discountValue;
        }

        discountAmount = Math.min(discountAmount, ticketPrice);

        await tx.promoCode.update({
          where: { id: promo.id },
          data: { usageCount: { increment: 1 } },
        });

        appliedPromoId = promo.id;
      }

      const finalPrice = Math.round((ticketPrice - discountAmount) * 100) / 100;
      const ticketCode = generateTicketCode();
      const qrCodeData = generateQRData(ticketCode);

      const newBooking = await tx.booking.create({
        data: {
          ticketCode,
          qrCodeData,
          userId: req.user!.userId,
          eventId,
          seatTierId: selectedTierId,
          promoCodeId: appliedPromoId,
          pricePaid: finalPrice,
          discountAmount,
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
        },
      });

      return newBooking;
    });

    res.status(201).json({
      success: true,
      data: booking,
      message: "Ticket purchased successfully",
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error creating booking:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("SOLD_OUT:")) {
      return res.status(409).json({
        success: false,
        error: "SOLD_OUT",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("INVALID_EVENT:")) {
      return res.status(400).json({
        success: false,
        error: "INVALID_EVENT",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("DUPLICATE:")) {
      return res.status(409).json({
        success: false,
        error: "DUPLICATE",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("VALIDATION:")) {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("INVALID_CODE:")) {
      return res.status(400).json({
        success: false,
        error: "INVALID_CODE",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("CODE_EXHAUSTED:")) {
      return res.status(400).json({
        success: false,
        error: "CODE_EXHAUSTED",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("MIN_PURCHASE:")) {
      return res.status(400).json({
        success: false,
        error: "MIN_PURCHASE",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to create booking",
    });
  }
});

// POST /api/bookings/:id/transfer - Transfer a confirmed ticket to another registered user
router.post("/:id/transfer", authenticate, async (req, res) => {
  try {
    const result = reassignBookingSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: result.error.errors[0].message,
      });
    }

    const { recipientEmail } = result.data;

    const transferredBooking = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: req.params.id as string },
      });

      if (!booking || booking.status === "TRANSFERRED") {
        throw new Error("NOT_FOUND:Booking not found");
      }

      if (booking.userId !== req.user!.userId) {
        throw new Error("FORBIDDEN:You can only transfer your own bookings");
      }

      const recipient = await tx.user.findUnique({
        where: { email: recipientEmail },
      });

      if (!recipient) {
        throw new Error("RECIPIENT_NOT_FOUND:Recipient must have a registered account");
      }

      return transferBooking(tx, booking.id, recipient.id);
    });

    res.json({
      success: true,
      data: transferredBooking,
      message: "Ticket transferred successfully",
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error transferring booking:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("FORBIDDEN:")) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("RECIPIENT_NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "RECIPIENT_NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("INVALID_STATUS:")) {
      return res.status(400).json({
        success: false,
        error: "INVALID_STATUS",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("SELF_TRANSFER:")) {
      return res.status(400).json({
        success: false,
        error: "SELF_TRANSFER",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("DUPLICATE:")) {
      return res.status(409).json({
        success: false,
        error: "DUPLICATE",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to transfer booking",
    });
  }
});

// DELETE /api/bookings/:id - Cancel booking with refund calculation
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: req.params.id as string },
        include: {
          event: true,
          seatTier: true,
        },
      });

      if (!booking || booking.status === "TRANSFERRED") {
        throw new Error("NOT_FOUND:Booking not found");
      }

      if (booking.userId !== req.user!.userId) {
        throw new Error("FORBIDDEN:You can only cancel your own bookings");
      }

      if (booking.status !== "CONFIRMED") {
        throw new Error(
          booking.status === "CANCELLED"
            ? "ALREADY_CANCELLED:This booking has already been cancelled"
            : "INVALID_STATUS:Only confirmed bookings can be cancelled"
        );
      }

      const refund = calculateRefund(
        booking.pricePaid,
        new Date(booking.event.date),
        booking.event.refundPolicy,
        booking.event.serviceFeePercent
      );

      if (!refund.canCancel) {
        throw new Error("PAST_EVENT:This event has already passed. Cancellation is not allowed.");
      }

      await tx.booking.update({
        where: { id: req.params.id as string },
        data: {
          status: "CANCELLED",
          refundAmount: refund.finalRefund,
          cancelledAt: new Date(),
        },
      });

      await decrementCapacity(tx, booking);

      if (booking.promoCodeId) {
        await tx.promoCode.update({
          where: { id: booking.promoCodeId },
          data: { usageCount: { decrement: 1 } },
        });
      }

      const promotedBooking = await promoteNextWaitlistedUser(tx, booking);

      return { refund, promotedBooking };
    });

    res.json({
      success: true,
      message: "Booking cancelled successfully",
      data: {
        refundAmount: result.refund.finalRefund,
        refundPercentage: result.refund.refundPercentage,
        serviceFee: result.refund.serviceFee,
        waitlistPromoted: Boolean(result.promotedBooking),
        promotedBookingId: result.promotedBooking?.id ?? null,
      },
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error cancelling booking:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("FORBIDDEN:")) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("ALREADY_CANCELLED:")) {
      return res.status(400).json({
        success: false,
        error: "ALREADY_CANCELLED",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("INVALID_STATUS:")) {
      return res.status(400).json({
        success: false,
        error: "INVALID_STATUS",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("PAST_EVENT:")) {
      return res.status(400).json({
        success: false,
        error: "PAST_EVENT",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to cancel booking",
    });
  }
});

// GET /api/bookings/:id/qr - Get QR code image
router.get("/:id/qr", authenticate, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id as string },
    });

    if (!booking || booking.status === "TRANSFERRED") {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "Booking not found",
      });
    }

    if (booking.userId !== req.user!.userId) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: "You can only view your own tickets",
      });
    }

    if (booking.status !== "CONFIRMED") {
      return res.status(400).json({
        success: false,
        error: "INVALID_STATUS",
        message: "QR code is not available for this booking",
      });
    }

    const qrCodeImage = await generateQRCodeDataURL(booking.qrCodeData);

    res.json({
      success: true,
      data: {
        qrCode: qrCodeImage,
        ticketCode: booking.ticketCode,
      },
    });
  } catch (error) {
    console.error("Error generating QR code:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to generate QR code",
    });
  }
});

export default router;
