import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const app = express();

// N'autorise que ton propre frontend à appeler ce backend
app.use(cors({ origin: "https://anavid51.github.io" }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const FLW_BASE = "https://api.flutterwave.com/v3";
const headers = {
  Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
  "Content-Type": "application/json",
};

const MARGE_CHANGE = 0.015; // 1.5% de marge sur la conversion
const FRAIS_RETRAIT = 300;  // FCFA fixes par retrait

// -- Inscription utilisateur (gère le lien mineur/tuteur) --
app.post("/api/users", async (req, res) => {
  const { nom, telephone, est_mineur, tuteur_telephone } = req.body;
  let tuteur_id = null;

  if (est_mineur) {
    const { data: tuteur } = await supabase
      .from("users")
      .select("id")
      .eq("telephone", tuteur_telephone)
      .single();
    if (!tuteur) return res.status(400).json({ error: "Le tuteur doit d'abord créer son propre compte." });
    tuteur_id = tuteur.id;
  }

  const { data, error } = await supabase
    .from("users")
    .insert({ nom, telephone, est_mineur, tuteur_id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// -- Encaisser un paiement client (USD/EUR) --
app.post("/api/collect", async (req, res) => {
  const { amount, currency, email, name, tx_ref, user_id } = req.body;
  try {
    const { data } = await axios.post(
      `${FLW_BASE}/payments`,
      {
        tx_ref,
        amount,
        currency,
        redirect_url: "https://anavid51.github.io/cauri/paiement-confirme",
        customer: { email, name },
        customizations: { title: "Cauri", description: "Paiement client international" },
      },
      { headers }
    );

    await supabase.from("transactions").insert({
      user_id, type: "collecte", montant: amount, devise: currency, flw_ref: tx_ref, statut: "en_attente",
    });

    res.json({ link: data.data.link });
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

// -- Vérifier un paiement après retour du client --
app.get("/api/verify/:transaction_id", async (req, res) => {
  try {
    const { data } = await axios.get(
      `${FLW_BASE}/transactions/${req.params.transaction_id}/verify`,
      { headers }
    );

    if (data.data.status === "successful") {
      const marge = data.data.amount * MARGE_CHANGE;

      const { data: tx } = await supabase
        .from("transactions")
        .update({ statut: "reussi", marge_cauri: marge })
        .eq("flw_ref", data.data.tx_ref)
        .select()
        .single();

      await supabase.from("revenu_plateforme").insert({
        montant: marge, source: "marge_change", transaction_id: tx?.id,
      });
    }
    res.json(data.data);
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

// -- Retrait utilisateur vers Mobile Money (MTN ou Moov Bénin) --
app.post("/api/payout", async (req, res) => {
  const { account_bank, account_number, amount, narration, user_id } = req.body;
  const montantNet = amount - FRAIS_RETRAIT;

  try {
    const { data } = await axios.post(
      `${FLW_BASE}/transfers`,
      {
        account_bank,
        account_number,
        amount: montantNet,
        currency: "XOF",
        narration,
        reference: `cauri-${Date.now()}`,
      },
      { headers }
    );

    const { data: tx } = await supabase
      .from("transactions")
      .insert({ user_id, type: "retrait", montant: amount, devise: "XOF", marge_cauri: FRAIS_RETRAIT, statut: "reussi" })
      .select()
      .single();

    await supabase.from("revenu_plateforme").insert({
      montant: FRAIS_RETRAIT, source: "frais_retrait", transaction_id: tx.id,
    });

    res.json(data.data);
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

// -- Solde d'un utilisateur --
app.get("/api/users/:id/solde", async (req, res) => {
  const { data: tx } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", req.params.id)
    .eq("statut", "reussi");
  const solde = tx.reduce((s, t) => s + (t.type === "collecte" ? Number(t.montant) : -Number(t.montant)), 0);
  res.json({ solde });
});

// -- Historique d'un utilisateur --
app.get("/api/users/:id/transactions", async (req, res) => {
  const { data } = await supabase
    .from("transactions")
    .select("*")
    .eq("user_id", req.params.id)
    .order("created_at", { ascending: false })
    .limit(10);
  res.json(data);
});

// -- Webhook Flutterwave --
app.post("/api/webhook", (req, res) => {
  const signature = req.headers["verif-hash"];
  if (!signature || signature !== process.env.FLW_SECRET_HASH) return res.status(401).end();
  console.log("Événement reçu :", req.body.event);
  res.status(200).end();
});

// -- Reverser les bénéfices accumulés vers ton propre numéro Mobile Money --
app.post("/api/admin/sweep-profits", async (req, res) => {
  const { data: revenus } = await supabase.from("revenu_plateforme").select("*").eq("reverse", false);
  const total = Math.floor(revenus.reduce((s, r) => s + Number(r.montant), 0));

  if (total < 500) return res.json({ message: "Montant trop faible pour un retrait", total });

  try {
    const { data } = await axios.post(
      `${FLW_BASE}/transfers`,
      {
        account_bank: process.env.OWNER_MOMO_NETWORK,
        account_number: process.env.OWNER_MOMO_NUMBER,
        amount: total,
        currency: "XOF",
        narration: "Reversement bénéfices Cauri",
        reference: `cauri-profit-${Date.now()}`,
      },
      { headers }
    );

    await supabase.from("revenu_plateforme").update({ reverse: true }).eq("reverse", false);
    res.json({ transfert: data.data, total });
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

app.get("/api/admin/revenu", async (req, res) => {
  const { data } = await supabase.from("revenu_plateforme").select("*").eq("reverse", false);
  const total = data.reduce((s, r) => s + Number(r.montant), 0);
  res.json({ total, detail: data });
});

app.get("/", (req, res) => res.send("Cauri backend en ligne."));

app.listen(process.env.PORT || 4000, () =>
  console.log(`Cauri backend actif sur le port ${process.env.PORT || 4000}`)
);
