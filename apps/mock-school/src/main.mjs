import http from "node:http";
import crypto from "node:crypto";

export class DeterministicMockSchoolBackend {
  constructor() {
    this.mode = "CONFIRM"; // CONFIRM | TIMEOUT_AMBIGUOUS | REJECT
    this.bookings = new Map();
  }

  setMode(mode) {
    this.mode = mode;
  }

  async handleCreateReservation({ job, plan, binding }) {
    const seatAlias = plan?.preferences_json?.preferred_seat_ids?.[0] || "N4-088";
    const regionAlias = plan?.preferences_json?.preferred_area_ids?.[0] || "北四楼自习区";
    const externalBookingId = `haut_mock_${job.booking_local_date}_${seatAlias}_${binding.id.slice(0, 6)}`;

    if (this.mode === "REJECT") {
      return {
        outcome: "FAILED",
        errorCode: "SEAT_ALREADY_TAKEN"
      };
    }

    // Record authoritative booking in mock school DB even if response times out!
    this.bookings.set(externalBookingId, {
      externalBookingId,
      schoolId: job.school_id,
      bindingId: binding.id,
      seatAlias,
      regionAlias,
      officialStatus: "CONFIRMED"
    });

    if (this.mode === "TIMEOUT_AMBIGUOUS") {
      return {
        outcome: "TIMEOUT_AMBIGUOUS",
        externalBookingId,
        seatAlias,
        regionAlias
      };
    }

    return {
      outcome: "SUBMITTED",
      externalBookingId,
      seatAlias,
      regionAlias
    };
  }

  async handleVerifyReservation({ job, binding, expectedExternalBookingId }) {
    const found = expectedExternalBookingId
      ? this.bookings.get(expectedExternalBookingId)
      : Array.from(this.bookings.values()).find((b) => b.bindingId === binding.id);
    if (!found) {
      return { verified: false, officialStatus: "NOT_FOUND" };
    }
    const evidenceSha256 = crypto
      .createHash("sha256")
      .update(`${job.school_id}|${binding.id}|${found.externalBookingId}|CONFIRMED`)
      .digest("hex");
    return {
      verified: true,
      externalBookingId: found.externalBookingId,
      officialStatus: found.officialStatus,
      seatAlias: found.seatAlias,
      regionAlias: found.regionAlias,
      evidenceSha256
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_SCHOOL_PORT || 8083);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "mock-school" }));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ service: "mock-school", port }));
  });
}
