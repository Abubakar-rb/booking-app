require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");

const app = express();
const { SHOPIFY_STORE, SHOPIFY_API_TOKEN, PORT } = process.env;

app.use(bodyParser.json());
app.use(cors());

const shopify = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/2024-01`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_API_TOKEN,
    "Content-Type": "application/json"
  }
});

// --------------------- Booking Utilities ---------------------
function isOverlapping(newB, existing) {
  return existing.some(b =>
    new Date(newB.start) < new Date(b.end) &&
    new Date(b.start) < new Date(newB.end)
  );
}

async function getBookings(productId) {
  try {
    const res = await shopify.get(`/products/${productId}/metafields.json`);
    const field = res.data.metafields.find(f => f.namespace === "custom" && f.key === "booking");
    const bookings = field ? JSON.parse(field.value || "[]") : [];
    return { metafield: field || null, bookings };
  } catch (err) {
    console.error("Error fetching bookings:", err);
    return { metafield: null, bookings: [] };
  }
}

async function saveBookings(productId, metafield, bookings) {
  if (metafield) {
    await shopify.put(`/metafields/${metafield.id}.json`, { metafield: { value: JSON.stringify(bookings), type: "json" } });
  } else {
    await shopify.post(`/products/${productId}/metafields.json`, {
      metafield: {
        namespace: "custom",
        key: "booking",
        type: "json",
        value: JSON.stringify(bookings)
      }
    });
  }
}

// --------------------- Endpoints ---------------------

// Get existing bookings
app.get("/availability", async (req, res) => {
  try {
    const productId = req.query.product_id;
    if (!productId) return res.json({ bookings: [] });
    const { bookings } = await getBookings(productId);
    res.json({ bookings });
  } catch (err) {
    console.error(err);
    res.json({ bookings: [] });
  }
});

// Validate a booking before adding to cart
app.post("/validate-booking", async (req, res) => {
  try {
    const { productId, checkin, checkout } = req.body;
    if (!productId || !checkin || !checkout) return res.status(400).json({ error: "Missing required fields" });

    const { bookings } = await getBookings(productId);
    const newBooking = { start: new Date(checkin).toISOString(), end: new Date(checkout).toISOString() };

    if (isOverlapping(newBooking, bookings)) {
      return res.status(400).json({ error: "Selected dates are already booked." });
    }

    res.json({ available: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while validating booking." });
  }
});

// Calculate dynamic price
app.post("/calculate-price", async (req, res) => {
  try {
    const { basePrice, guests, checkin, checkout } = req.body;
    if (!basePrice || !guests || !checkin || !checkout) return res.status(400).json({ error: "Missing required fields" });

    const nights = Math.ceil((new Date(checkout) - new Date(checkin)) / (1000 * 60 * 60 * 24));
    const totalPrice = basePrice * nights * guests;

    res.json({ nights: nights || 1, totalPrice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while calculating price." });
  }
});

// Create Draft Order (NEW: for dynamic pricing)
app.post("/create-draft-order", async (req, res) => {
  try {
    const { productId, checkin, checkout, guests, totalPrice, email } = req.body;
    if (!productId || !checkin || !checkout || !guests || !totalPrice || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const draftOrderPayload = {
      draft_order: {
        line_items: [
          {
            variant_id: productId,
            quantity: 1,
            price: totalPrice.toFixed(2),
            properties: {
              "Check In": checkin,
              "Check Out": checkout,
              "Guests": guests
            }
          }
        ],
        customer: { email },
        use_customer_default_address: true,
        send_invoice: true
      }
    };

    const response = await shopify.post("/draft_orders.json", draftOrderPayload);
    res.json({ invoice_url: response.data.draft_order.invoice_url });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: "Error creating draft order" });
  }
});

// Webhook: save bookings when order created
app.post("/webhooks/orders-create", async (req, res) => {
  try {
    const order = req.body;
    if (!order?.line_items) return res.status(400).send("No line_items found");

    for (const item of order.line_items) {
      const checkIn = item.properties?.find(p => p.name === "Check In")?.value;
      const checkOut = item.properties?.find(p => p.name === "Check Out")?.value;
      if (!checkIn || !checkOut || !item.product_id) continue;

      const booking = { start: new Date(checkIn).toISOString(), end: new Date(checkOut).toISOString() };
      const { metafield, bookings } = await getBookings(item.product_id);

      if (isOverlapping(booking, bookings)) continue;

      bookings.push(booking);
      await saveBookings(item.product_id, metafield, bookings);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT || 3000, () => {
  console.log("🚀 Booking server running");
});
