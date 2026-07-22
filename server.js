import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors({ origin: "https://anavid51.github.io" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // CinetPay envoie parfois le webhook en x-www-form-urlencoded

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CHECKOUT_BASE = "https://api-checkout.cinetpay.com/v2";
const TRANSFER_BASE = "https://client.cinetpay.com/v1";

const FRAIS_RETRAIT = 300; // FCFA fixes par retrait, notre marge

// ---------- Utilitaires CinetPay ----------

// Récupère un token pour l'API de transfert (valable 5 min, on en redemande un à chaque fois par simplicité)
async function getTransferToken() {
  const { data } = await axios.post(
    `${TRANSFER_BASE}/auth/login`,
    new URLSearchParams({
      apikey: process.env.CINETPAY_APIKEY,
      password: process.env.CINETPAY_TRANSFER_PASSWORD,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  if (data.code !== 0) throw new Error(data.message || "Échec génération token transfert");
  return data.data.token;
}

// Un numéro doit être dans les contacts CinetPay avant de recevoir un transfert
async function ajouterContact(token, prefix, phone, name = "Utilisateur", surname = "Cauri") {
  await axios.post(
    `${TRANSFER_BASE}/transfer/money/send/contact?token=${token}&lang=fr`,
    [{ prefix, phone, name, surname, email: "" }],
    { headers: { "Content-Type": "application/json" } }
  );
}

async function envoyerArgent(token, prefix, phone, amount, client_transaction_id, notify_url) {
  const montantArrondi = Math.floor(amount / 5) * 5; // CinetPay exige un multiple de 5
  const { data } = await axios.post(
    `${TRANSFER_BASE}/transfer/money/send?token=${token}&lang=fr`,
    [{ prefix, phone, amount: montantArrondi, client_transaction_id, notify_url }],
    { headers: { "Content-Type": "application/json" } }
  );
  return data;
}

// ---------- Inscription utilisateur (mineur/tuteur) ----------

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

// ---------- Encaisser un paiement client ----------

app.post("/api/collect", async (req, res) => {
  const { amount, email, name, tx_ref, user_id } = req.body;
  try {
    const { data } = await axios.post(`${CHECKOUT_BASE}/payment`, {
      apikey: process.env.CINETPAY_APIKEY,
      site_id: process.env.CINETPAY_SITE_ID,
      transaction_id: tx_ref,
      amount,
      currency: "XOF",
      description: "Paiement Cauri",
      return_url: "https://anavid51.github.io/cauri/paiement-confirme",
      notify_url: "https://cauri-backend.onrender.com/api/webhook",
      customer_name: name || "Client",
      customer_surname: "Cauri",
      channels: "ALL",
    });

    if (data.code !== "201") return res.status(400).json({ error: data });

    await supabase.from("transactions").insert({
      user_id, type: "collecte", montant: amount, devise: "XOF", flw_ref: tx_ref, statut: "en_attente",
    });

    res.json({ link: data.data.payment_url });
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

// ---------- Vérifier un paiement ----------

async function verifierPaiement(transaction_id) {
  const { data } = await axios.post(`${CHECKOUT_BASE}/payment/check`, {
    apikey: process.env.CINETPAY_APIKEY,
    site_id: process.env.CINETPAY_SITE_ID,
    transaction_id,
  });
  return data;
}

app.get("/api/verify/:transaction_id", async (req, res) => {
  try {
    const data = await verifierPaiement(req.params.transaction_id);

    if (data.code === "00") { // "00" = paiement accepté côté CinetPay
      const { data: tx } = await supabase
        .from("transactions")
        .update({ statut: "reussi" })
        .eq("flw_ref", req.params.transaction_id)
        .select()
        .single();

      const marge = Math.round(data.data.amount * 0.015);
      await supabase.from("revenu_plateforme").insert({
        montant: marge, source: "marge_service", transaction_id: tx?.id,
      });
    }
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

// ---------- Retrait utilisateur vers Mobile Money ----------

app.post("/api/payout", async (req, res) => {
  const { prefix, phone, amount, user_id } = req.body;
  const montantNet = amount - FRAIS_RETRAIT;

  try {
    const token = await getTransferToken();
    await ajouterContact(token, prefix, phone);
    const ref = `cauri-${Date.now()}`;
    const resultat = await envoyerArgent(
      token, prefix, phone, montantNet, ref,
      "https://cauri-backend.onrender.com/api/webhook"
    );

    const { data: tx } = await supabase
      .from("transactions")
      .insert({ user_id, type: "retrait", montant: amount, devise: "XOF", marge_cauri: FRAIS_RETRAIT, statut: "en_attente" })
      .select()
      .single();

    await supabase.from("revenu_plateforme").insert({
      montant: FRAIS_RETRAIT, source: "frais_retrait", transaction_id: tx.id,
    });

    res.json(resultat);
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

// ---------- Solde et historique utilisateur ----------

app.get("/api/users/:id/solde", async (req, res) => {
  const { data: tx } = await supabase
    .from("transactions").select("*").eq("user_id", req.params.id).eq("statut", "reussi");
  const solde = tx.reduce((s, t) => s + (t.type === "collecte" ? Number(t.montant) : -Number(t.montant)), 0);
  res.json({ solde });
});

app.get("/api/users/:id/transactions", async (req, res) => {
  const { data } = await supabase
    .from("transactions").select("*").eq("user_id", req.params.id)
    .order("created_at", { ascending: false }).limit(10);
  res.json(data);
});

// ---------- Webhook CinetPay ----------
// CinetPay recommande de ne jamais faire confiance au contenu du webhook :
// on reprend juste l'id de transaction reçu et on revérifie nous-mêmes.
app.post("/api/webhook", async (req, res) => {
  try {
    const transactionId = req.body.cpm_trans_id || req.body.client_transaction_id;
    if (transactionId) await verifierPaiement(transactionId);
    res.status(200).end();
  } catch {
    res.status(200).end(); // on répond 200 quand même pour éviter que CinetPay ne réessaie en boucle
  }
});

// ---------- Reverser les bénéfices vers ton propre numéro ----------

app.post("/api/admin/sweep-profits", async (req, res) => {
  const { data: revenus } = await supabase.from("revenu_plateforme").select("*").eq("reverse", false);
  const total = Math.floor(revenus.reduce((s, r) => s + Number(r.montant), 0) / 5) * 5;

  if (total < 500) return res.json({ message: "Montant trop faible pour un retrait", total });

  try {
    const token = await getTransferToken();
    await ajouterContact(token, process.env.OWNER_MOMO_PREFIX, process.env.OWNER_MOMO_PHONE, "Cauri", "Plateforme");
    const resultat = await envoyerArgent(
      token, process.env.OWNER_MOMO_PREFIX, process.env.OWNER_MOMO_PHONE, total,
      `cauri-profit-${Date.now()}`, "https://cauri-backend.onrender.com/api/webhook"
    );

    await supabase.from("revenu_plateforme").update({ reverse: true }).eq("reverse", false);
    res.json({ transfert: resultat, total });
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
});

app.get("/api/admin/revenu", async (req, res) => {
  const { data } = await supabase.from("revenu_plateforme").select("*").eq("reverse", false);
  const total = data.reduce((s, r) => s + Number(r.montant), 0);
  res.json({ total, detail: data });
});

app.get("/", (req, res) => res.send("Cauri backend (CinetPay) en ligne."));

app.listen(process.env.PORT || 4000, () =>
  console.log(`Cauri backend actif sur le port ${process.env.PORT || 4000}`)
);
