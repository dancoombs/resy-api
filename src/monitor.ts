import cron from "node-schedule";
import log from "./log";
import ResyService from "./controllers/ResyService";
import TextService from "./controllers/TextService";
import type { VenueToWatch } from "./controllers/VenuesService";
import VenuesService from "./controllers/VenuesService";
import dayjs from "dayjs";
import type { EnhancedSlot } from "./types/find";
import * as dotenv from 'dotenv';

dotenv.config();
const email = process.env.RESY_EMAIL!;
const password = process.env.RESY_PASSWORD!;
const service = new ResyService({
  email,
  password,
});

const textController = new TextService();
const venuesService = new VenuesService();

const parsePossibleSlots = async (
  venue: VenueToWatch,
  possibleSlots: EnhancedSlot[]
) => {
  const dateToCheck = possibleSlots[0].date.start;
  log.info(
    `Found ${possibleSlots.length} valid open slots on ${dateToCheck} for ${venue.name}`
  );
  if (venue.preferredTime) {
    const date = possibleSlots[0].start!.format("YYYY-MM-DD");
    const preferredTime = dayjs(`${date} ${venue.preferredTime}`);
    possibleSlots.forEach((slot) => {
      slot.diff = Math.abs(slot.start!.diff(preferredTime));
    });
    possibleSlots.sort((slotA, slotB) => {
      return slotA.diff - slotB.diff;
    });
  }

  const userDetails = await service.getUser();
  for (const slot of possibleSlots) {
    log.info(`Found time to book - ${slot.date.start}`);
    const configId = slot.config.token;
    const timeDetails = await service.details({
      commit: 1,
      config_id: configId,
      party_size: venue.partySize ?? 2,
      day: (dateToCheck || "").split(" ")[0] || slot.shift.day,
    });

    try {
      const bookingResponse = await service.book({
        book_token: timeDetails!.data!.book_token!.value!,
        struct_payment_method: `{"id":${userDetails.data.payment_methods[0].id}}`,
        source_id: "resy.com-venue-details",
      });
      venue.reservationDetails = bookingResponse.data;
      log.info(`Successfully booked at ${venue.name}`);

      await textController.sendText(
        `Booked ${venue.name} at ${slot.date.start}`
      );
      return
    } catch (e) {
      log.error(e)
      continue;
    }
  }
};

const refreshAvailabilityForVenue = async (venue: VenueToWatch) => {
  try {
    const dateToCheck = dayjs().add(venue.intervalDays-1, 'day').format("YYYY-MM-DD");
    log.info(`Checking ${venue.name} on ${dateToCheck}`);
    const slots = (await service.getAvailableTimesForVenueAndDate(
      venue.id,
      dateToCheck,
      venue.partySize
    )) as EnhancedSlot[];
    if (!slots.length) {
      log.info(`No slots found for ${venue.name}`);
      return;
    }

    const possibleSlots = slots.filter((slot) => {
      const start = dayjs(slot.date.start);
      const minTime = dayjs(`${start.format("YYYY-MM-DD")} ${venue.minTime}`);
      const maxTime = dayjs(`${start.format("YYYY-MM-DD")} ${venue.maxTime}`);
      slot.start = start;
      return start >= minTime && start <= maxTime;
    });

    if (possibleSlots.length) {
      await parsePossibleSlots(venue, possibleSlots);
      return;
    }
  } catch (e) {
    console.error(e);
  }
};

const refreshAvailability = async () => {
  log.info("Finding reservations");

  await venuesService.init();
  const venuesToSearchFor = await venuesService.getWatchedVenues();
  // You get more availability if you have an amex card and you log in

  for (const venue of venuesToSearchFor) {
    await refreshAvailabilityForVenue(venue);
  }
  await venuesService.save();
  log.info("Finished finding reservations");
};

const regenerateHeaders = async () => {
  try {
    if (!email || !password) {
      log.warn(
        "Email or password not set, did you forget to set the environment variables?"
      );
      return;
    }
    await service.generateHeadersAndLogin();
  } catch (e) {
    log.error(e);
    log.error("Error regenerating headers and logging in");
    process.exit(1);
  }
};

// Always refresh at the end of an hour
cron.scheduleJob("59 * * * *", regenerateHeaders);
// Set configured cron jobs
venuesService.init().then(async () => {
  const venuesToSearchFor = await venuesService.getWatchedVenues();
  for (const venue of venuesToSearchFor) {
    log.info(`Setting cron job with for ${venue.name} with interval ${venue.intervalDays} days at times ${venue.cron}`)
    const func = async function() {
      await refreshAvailabilityForVenue(venue);
    };
    cron.scheduleJob(venue.cron, func);
  }
});
// Try once at start
regenerateHeaders().then(async () => {
  await refreshAvailability();
});
