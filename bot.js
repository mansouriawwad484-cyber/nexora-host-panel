require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const db = require("./src-db");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const OWNER_ID = process.env.OWNER_DISCORD_ID || "1277871426216529953";
const PLANS = {
  starter: { label: "Starter Panel", cost: 100 },
  standard: { label: "Standard Panel", cost: 250 }
};


const commands = [
  new SlashCommandBuilder().setName("balance").setDescription("عرض رصيد الكوينزات الخاص بك"),
  new SlashCommandBuilder().setName("buy-panel").setDescription("شراء طلب Panel باستخدام الكوينزات")
    .addStringOption(o => o.setName("plan").setDescription("اختر الباقة").setRequired(true)
      .addChoices({ name: "Starter Panel — 100 كوينز", value: "starter" }, { name: "Standard Panel — 250 كوينز", value: "standard" })),
  new SlashCommandBuilder().setName("my-orders").setDescription("عرض طلبات الشراء الخاصة بك"),
  new SlashCommandBuilder().setName("add-coins").setDescription("[مالك فقط] إضافة كوينزات لعضو")
    .addUserOption(o => o.setName("member").setDescription("العضو المستهدف").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("عدد الكوينزات").setMinValue(1).setMaxValue(1000000).setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("سبب الإضافة").setMaxLength(200)),
  new SlashCommandBuilder().setName("host-users").setDescription("[مالك فقط] عرض أعضاء Nexora المسجلين"),
  new SlashCommandBuilder().setName("host-orders").setDescription("[مالك فقط] عرض أحدث طلبات الشراء"),
  new SlashCommandBuilder().setName("coin-log").setDescription("[مالك فقط] عرض آخر حركات الكوينزات")
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const money = n => Number(n || 0).toLocaleString("en-US");
const ownerOnly = interaction => interaction.user.id === OWNER_ID;
const embed = (title, description) => new EmbedBuilder().setColor(0x9d8cff).setTitle(title).setDescription(description).setTimestamp();

if (TOKEN && CLIENT_ID) {
  client.once("ready", async () => {
    console.log(`Nexora Host Discord bot online as ${client.user.tag}`);
    try {
      const rest = new REST({ version: "10" }).setToken(TOKEN);
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("Nexora Host slash commands registered globally.");
    } catch (e) { console.error("Slash command registration failed:", e.message); }
  });
} else {
  console.log("Discord bot disabled: set DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID to enable slash commands.");
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    const userId = interaction.user.id;
    if (interaction.commandName === "balance") {
      const user = db.prepare("SELECT username, coins FROM users WHERE id=?").get(userId);
      return interaction.reply({ embeds: [embed("رصيد Nexora Host", user ? `الحساب: **${user.username}**\nرصيدك: **${money(user.coins)} كوينز**` : "ما عندك حساب مسجل في Nexora Host بعد. سجّل دخولك للموقع عبر Discord أولاً.")], ephemeral: true });
    }
    if (interaction.commandName === "buy-panel") {
      const planKey = interaction.options.getString("plan", true);
      const plan = PLANS[planKey];
      const user = db.prepare("SELECT coins FROM users WHERE id=?").get(userId);
      if (!user) return interaction.reply({ content: "سجّل دخولك للموقع عبر Discord أولاً حتى يتم إنشاء حسابك.", ephemeral: true });
      if (user.coins < plan.cost) return interaction.reply({ content: `رصيدك غير كافٍ. تحتاج **${plan.cost}** كوينز ورصيدك **${user.coins}**.`, ephemeral: true });
      const purchase = db.transaction(() => {
        const fresh = db.prepare("SELECT coins FROM users WHERE id=?").get(userId);
        if (!fresh || fresh.coins < plan.cost) throw new Error("INSUFFICIENT_COINS");
        db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(plan.cost, userId);
        db.prepare("INSERT INTO coin_transactions (user_id, actor_id, amount, reason, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(userId, userId, -plan.cost, `Purchase: ${plan.label}`);
        db.prepare("INSERT INTO panel_orders (user_id, plan_key, cost, status, created_at) VALUES (?, ?, ?, 'pending', datetime('now'))").run(userId, planKey, plan.cost);
      });
      try { purchase(); } catch (e) { if (e.message === "INSUFFICIENT_COINS") return interaction.reply({ content: "رصيدك غير كافٍ لإكمال الطلب.", ephemeral: true }); throw e; }
      return interaction.reply({ embeds: [embed("تم تسجيل طلب الشراء", `تم تسجيل طلب **${plan.label}** مقابل **${plan.cost} كوينز**.\nملاحظة: النظام يسجل الطلب فقط ولا ينشئ استضافة فعلية أو يشغّل ملفات البوتات بعد.`)], ephemeral: true });
    }
    if (interaction.commandName === "my-orders") {
      const orders = db.prepare("SELECT id, plan_key, cost, status, created_at FROM panel_orders WHERE user_id=? ORDER BY id DESC LIMIT 10").all(userId);
      const text = orders.length ? orders.map(o => `**#${o.id}** • ${PLANS[o.plan_key]?.label || o.plan_key} • ${money(o.cost)} كوينز • ${o.status} • ${o.created_at}`).join("\n") : "ما عندك طلبات شراء حتى الآن.";
      return interaction.reply({ embeds: [embed("طلباتك الأخيرة", text)], ephemeral: true });
    }
    if (["add-coins", "host-users", "host-orders", "coin-log"].includes(interaction.commandName) && !ownerOnly(interaction)) {
      return interaction.reply({ content: "هذا الأمر متاح لمالك Nexora Host فقط.", ephemeral: true });
    }
    if (interaction.commandName === "add-coins") {
      const target = interaction.options.getUser("member", true);
      const amount = interaction.options.getInteger("amount", true);
      const reason = interaction.options.getString("reason") || "منح عبر Discord";
      const exists = db.prepare("SELECT id FROM users WHERE id=?").get(target.id);
      if (!exists) return interaction.reply({ content: "هذا العضو غير مسجل في Nexora Host. يجب أن يسجل الدخول للموقع أولاً.", ephemeral: true });
      db.transaction(() => {
        db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(amount, target.id);
        db.prepare("INSERT INTO coin_transactions (user_id, actor_id, amount, reason, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(target.id, userId, amount, reason.slice(0, 200));
      })();
      return interaction.reply({ embeds: [embed("تمت إضافة الكوينزات", `العضو: <@${target.id}>\nالكمية: **${money(amount)}**\nالسبب: ${reason}`)], ephemeral: true });
    }
    if (interaction.commandName === "host-users") {
      const rows = db.prepare("SELECT id, username, coins FROM users ORDER BY coins DESC LIMIT 15").all();
      return interaction.reply({ embeds: [embed("أعضاء Nexora Host", rows.length ? rows.map(u => `• **${u.username}** (<@${u.id}>) — ${money(u.coins)} كوينز`).join("\n") : "لا يوجد أعضاء مسجلون بعد.")], ephemeral: true });
    }
    if (interaction.commandName === "host-orders") {
      const rows = db.prepare("SELECT panel_orders.id, panel_orders.user_id, users.username, panel_orders.plan_key, panel_orders.cost, panel_orders.status, panel_orders.created_at FROM panel_orders LEFT JOIN users ON users.id=panel_orders.user_id ORDER BY panel_orders.id DESC LIMIT 15").all();
      return interaction.reply({ embeds: [embed("أحدث طلبات الشراء", rows.length ? rows.map(o => `**#${o.id}** • ${o.username || o.user_id} • ${PLANS[o.plan_key]?.label || o.plan_key} • ${money(o.cost)} • ${o.status} • ${o.created_at}`).join("\n") : "لا توجد طلبات شراء حتى الآن.")], ephemeral: true });
    }
    if (interaction.commandName === "coin-log") {
      const rows = db.prepare("SELECT user_id, actor_id, amount, reason, created_at FROM coin_transactions ORDER BY id DESC LIMIT 15").all();
      return interaction.reply({ embeds: [embed("سجل حركة الكوينزات", rows.length ? rows.map(t => `• <@${t.user_id}> • ${t.amount > 0 ? "+" : ""}${money(t.amount)} • ${t.reason} • المنفذ <@${t.actor_id}> • ${t.created_at}`).join("\n") : "لا توجد حركات كوينزات بعد.")], ephemeral: true });
    }
  } catch (error) {
    console.error("Discord interaction error:", error);
    const payload = { content: "صار خطأ أثناء تنفيذ الأمر. حاول مرة ثانية لاحقًا.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

if (TOKEN && CLIENT_ID) client.login(TOKEN).catch(error => console.error("Discord bot login failed:", error.message));
