import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

async function getWaitlistPosition(tx: any, eventId: string, userId: string) {
  const entries = await tx.waitlistEntry.findMany({
    where: { eventId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      userId: true,
      createdAt: true,
    },
  });

  const index = entries.findIndex((entry: any) => entry.userId === userId);

  if (index === -1) {
    return null;
  }

  return {
    position: index + 1,
    total: entries.length,
  };
}

// GET /api/waitlist - List current user's waitlist entries with positions
router.get("/", authenticate, async (req, res) => {
  try {
    const entries = await prisma.waitlistEntry.findMany({
      where: {
        userId: req.user!.userId,
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
            capacity: true,
            soldCount: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    const data = await Promise.all(
      entries.map(async (entry) => {
        const position = await getWaitlistPosition(prisma, entry.eventId, req.user!.userId);

        return {
          id: entry.id,
          createdAt: entry.createdAt,
          event: entry.event,
          position: position?.position ?? null,
          totalWaitlistSize: position?.total ?? 0,
        };
      })
    );

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching waitlist entries:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to fetch waitlist entries",
    });
  }
});

// GET /api/waitlist/:eventId - Get current user's waitlist position for an event
router.get("/:eventId", authenticate, async (req, res) => {
  try {
    const eventId = req.params.eventId as string;

    const entry = await prisma.waitlistEntry.findFirst({
      where: {
        eventId,
        userId: req.user!.userId,
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
            capacity: true,
            soldCount: true,
          },
        },
      },
    });

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "You are not on the waitlist for this event",
      });
    }

    const position = await getWaitlistPosition(prisma, eventId, req.user!.userId);

    res.json({
      success: true,
      data: {
        id: entry.id,
        createdAt: entry.createdAt,
        event: entry.event,
        position: position?.position ?? null,
        totalWaitlistSize: position?.total ?? 0,
      },
    });
  } catch (error) {
    console.error("Error fetching waitlist position:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to fetch waitlist position",
    });
  }
});

// POST /api/waitlist/:eventId - Join waitlist for a sold-out event
router.post("/:eventId", authenticate, async (req, res) => {
  try {
    const eventId = req.params.eventId as string;

    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
      });

      if (!event) {
        throw new Error("NOT_FOUND:Event not found");
      }

      if (event.status !== "PUBLISHED") {
        throw new Error("INVALID_EVENT:Event is not open for waitlist");
      }

      if (event.soldCount < event.capacity) {
        throw new Error("NOT_SOLD_OUT:This event is not sold out");
      }

      const existingBooking = await tx.booking.findFirst({
        where: {
          userId: req.user!.userId,
          eventId,
          status: {
            in: ["CONFIRMED", "CHECKED_IN"],
          },
        },
      });

      if (existingBooking) {
        throw new Error("DUPLICATE_BOOKING:You already have a ticket for this event");
      }

      const existingEntry = await tx.waitlistEntry.findFirst({
        where: {
          eventId,
          userId: req.user!.userId,
        },
      });

      if (existingEntry) {
        throw new Error("ALREADY_WAITLISTED:You are already on the waitlist for this event");
      }

      const entry = await tx.waitlistEntry.create({
        data: {
          eventId,
          userId: req.user!.userId,
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
        },
      });

      const position = await getWaitlistPosition(tx, eventId, req.user!.userId);

      return { entry, position };
    });

    res.status(201).json({
      success: true,
      data: {
        id: result.entry.id,
        createdAt: result.entry.createdAt,
        event: result.entry.event,
        position: result.position?.position ?? null,
        totalWaitlistSize: result.position?.total ?? 0,
      },
      message: "Added to waitlist successfully",
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error joining waitlist:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
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

    if (err.message?.startsWith("NOT_SOLD_OUT:")) {
      return res.status(400).json({
        success: false,
        error: "NOT_SOLD_OUT",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("DUPLICATE_BOOKING:")) {
      return res.status(409).json({
        success: false,
        error: "DUPLICATE_BOOKING",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("ALREADY_WAITLISTED:")) {
      return res.status(409).json({
        success: false,
        error: "ALREADY_WAITLISTED",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to join waitlist",
    });
  }
});

// DELETE /api/waitlist/:eventId - Leave waitlist for an event
router.delete("/:eventId", authenticate, async (req, res) => {
  try {
    const eventId = req.params.eventId as string;

    const deleted = await prisma.waitlistEntry.deleteMany({
      where: {
        eventId,
        userId: req.user!.userId,
      },
    });

    if (deleted.count === 0) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "You are not on the waitlist for this event",
      });
    }

    res.json({
      success: true,
      message: "Removed from waitlist successfully",
    });
  } catch (error) {
    console.error("Error leaving waitlist:", error);
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to leave waitlist",
    });
  }
});

export default router;
