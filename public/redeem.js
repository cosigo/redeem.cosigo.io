(function () {
  // ===== CONFIG (MAIN COSIGO) =====
  const CONTRACT_ADDRESS = "0x0F1e8EE8a035270ED9952591d7DBDc600E2B4A49";
  const CHAIN_ID_DEC = 1; // Ethereum mainnet
  const TOKEN_DECIMALS = 18; // confirmed

  // Minimal ABI
  const ABI = [
    "function decimals() view returns (uint8)",
    "function paused() view returns (bool)",
    "function redemptionFeeBps() view returns (uint16)",
    "function minRedemptionMg1e18() view returns (uint256)",
    "function dailyCapPerAddrMg1e18() view returns (uint256)",
    "function dailyCapGlobalMg1e18() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function redeemPhysicalSilver(uint256 mg1e18, string shippingRefStr)"
  ];

  // ===== DOM HELPERS =====
  const $ = (id) => document.getElementById(id);
  const say = (t, c = "#b91c1c") => {
    const m = $("cr_msg");
    m.style.color = c;
    m.textContent = t || "";
  };
  const ok = (t) => say(t, "#065f46");

  const hex = (bn) => "0x" + BigInt(bn).toString(16);

  // ===== REFERENCE STRING =====
  const toRef = (delivery, zip) => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    let r =
      `${delivery === "ship" ? "SHIP" : "INPERSON"}-` +
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
      `${p(d.getHours())}${p(d.getMinutes())}`;
    if (zip) r += "-" + zip;
    return r;
  };

  // ===== STATE =====
  let g = {
    provider: null,
    signer: null,
    user: null,
    c: null,
    dec: TOKEN_DECIMALS
  };

  // ===== WALLET CONNECTION (EXPLICIT) =====
  async function connectWallet() {
    if (!window.ethereum) throw new Error("No wallet found.");
    await window.ethereum.request({ method: "eth_requestAccounts" });
  }

  // ===== SETUP (NO WALLET POPUP) =====
  async function setup() {
    if (!window.ethereum) {
      throw new Error("No wallet found. Open this page in a wallet-enabled browser.");
    }

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const user = await signer.getAddress();

    const chainHex = await window.ethereum.request({ method: "eth_chainId" });
    const chainDec = parseInt(chainHex, 16);
    if (chainDec !== CHAIN_ID_DEC) {
      throw new Error(`Wrong network. Switch to Ethereum mainnet.`);
    }

    const c = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const dec = await c.decimals().catch(() => TOKEN_DECIMALS);

    g = { provider, signer, user, c, dec };

    // Debug panel
    $("dbg_acct").textContent = user;
    $("dbg_chain").textContent = String(chainDec);
    $("dbg_token").textContent = CONTRACT_ADDRESS;
    $("dbg_dec").textContent = String(dec);

    try {
      const ethBal = await provider.getBalance(user);
      $("dbg_eth").textContent = ethers.formatEther(ethBal) + " ETH";
    } catch {}

    return g;
  }

  // ===== UNIT CONVERSIONS =====
  // Human unit: mg
  // Contract unit: 18-decimal token units

  function mgToUnits(mg) {
    return BigInt(mg) * (10n ** 18n);
  }

  function unitsToMg(units) {
    return (BigInt(units) / (10n ** 18n)).toString();
  }

  // ===== POLICY READ =====
  async function readPolicy() {
    const [paused, feeBps, minMg, capAddr, capGlob] = await Promise.all([
      g.c.paused().catch(() => true),
      g.c.redemptionFeeBps().catch(() => 0),
      g.c.minRedemptionMg1e18().catch(() => 0n),
      g.c.dailyCapPerAddrMg1e18().catch(() => 0n),
      g.c.dailyCapGlobalMg1e18().catch(() => 0n)
    ]);

    return {
      paused,
      feeBps: BigInt(feeBps),
      minMg1e18: BigInt(minMg),
      capAddr: BigInt(capAddr),
      capGlob: BigInt(capGlob)
    };
  }

  function previewFromInputs(mgBigInt, feeBpsBig) {
    const mgWei = mgToUnits(mgBigInt);
    const feeWei = (mgWei * feeBpsBig) / 10000n;
    const burn = mgWei + feeWei;
    return { mgWei, feeWei, burn };
  }

  async function preflight(mgWei, ref) {
    await g.c.redeemPhysicalSilver.staticCall(mgWei, ref);
  }

  async function redeem(mgWei, ref) {
    try {
      const tx = await g.c.redeemPhysicalSilver(mgWei, ref);
      return tx.hash;
    } catch {
      const iface = new ethers.Interface([
        "function redeemPhysicalSilver(uint256,string)"
      ]);
      const data = iface.encodeFunctionData(
        "redeemPhysicalSilver",
        [mgWei, ref]
      );

      const txReq = {
        from: g.user,
        to: CONTRACT_ADDRESS,
        data,
        value: "0x0"
      };

      try {
        const gas = await g.provider.estimateGas(txReq).catch(() => null);
        if (gas) txReq.gas = hex(gas);
      } catch {}

      return await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [txReq]
      });
    }
  }

  // ===== PREVIEW (READ-ONLY) =====
  async function onPreview() {
    $("cr_quote").style.display = "none";
    $("cr_quote").innerHTML = "";

    try {
      if (!g.c) await setup();
      say("");

      const amountStr = $("cr_amount").value.trim();
      if (!amountStr || !/^\d+$/.test(amountStr)) {
        return say("Enter an integer amount in mg.");
      }

      const mg = BigInt(amountStr);
      if (mg <= 0n) return say("Amount must be positive.");

      const policy = await readPolicy();
      if (policy.paused) return say("Redemptions are paused.");

      const { mgWei, feeWei, burn } =
        previewFromInputs(mg, policy.feeBps);

      if (policy.minMg1e18 > 0n && mgWei < policy.minMg1e18) {
        return say(
          `Below minimum redemption: need at least ` +
          `${(policy.minMg1e18 / (10n ** 18n)).toString()} mg.`
        );
      }

      $("cr_quote").style.display = "block";
      $("cr_quote").innerHTML =
        `<div style="font-weight:800;margin-bottom:6px">Preview</div>
         <div>Gross: <b>${mg}</b> mg</div>
         <div>Redemption fee: <b>${unitsToMg(feeWei)}</b> mg</div>
         <div>Total burn: <b>${unitsToMg(burn)}</b> mg</div>
         <div>Net physical silver: <b>${mg}</b> mg</div>`;

      ok("Preview ready.");
    } catch (e) {
      say("Preview error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  // ===== REDEEM (ON-CHAIN) =====
  async function onRedeem() {
    const result = $("cr_result");
    result.style.display = "none";
    result.innerHTML = "";

    try {
      await connectWallet();
      if (!g.c) await setup();
      say("");

      const amountStr = $("cr_amount").value.trim();
      if (!amountStr || !/^\d+$/.test(amountStr)) {
        return say("Enter an integer amount in mg.");
      }

      const mg = BigInt(amountStr);
      if (mg <= 0n) return say("Amount must be positive.");

      const delivery = $("cr_delivery").value || "inperson";
      const zip = ($("cr_zip").value || "").trim().slice(0, 10);

      const policy = await readPolicy();
      if (policy.paused) return say("Redemptions are paused.");

      const { mgWei, feeWei, burn } =
        previewFromInputs(mg, policy.feeBps);

      if (policy.minMg1e18 > 0n && mgWei < policy.minMg1e18) {
        return say(
          `Below minimum redemption: need at least ` +
          `${(policy.minMg1e18 / (10n ** 18n)).toString()} mg.`
        );
      }

      const bal = await g.c.balanceOf(g.user).catch(() => 0n);
      if (bal < burn) {
        return say("Insufficient Cosigo balance to cover amount + fee.");
      }

      const ref = toRef(delivery, zip);
      await preflight(mgWei, ref);

      const btn = $("cr_btn");
      btn.disabled = true;
      btn.textContent = "Submitting…";

      ok("Opening wallet…");
      const txHash = await redeem(mgWei, ref);

      ok("Transaction sent: " + txHash);
      result.style.display = "block";
      result.innerHTML =
        `<div style="color:#065f46;font-weight:800;margin-bottom:6px">
           Redemption submitted ✅
         </div>
         <div>Tx: <code>${txHash}</code></div>
         <div>Gross: ${mg} mg</div>
         <div>Redemption fee: ${unitsToMg(feeWei)} mg</div>
         <div>Total burn: ${unitsToMg(burn)} mg</div>`;

      btn.disabled = false;
      btn.textContent = "Open wallet & redeem";
    } catch (e) {
      say("Error: " + (e?.shortMessage || e?.message || String(e)));
      const btn = $("cr_btn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Open wallet & redeem";
      }
    }
  }

  $("cr_preview").addEventListener("click", (e) => {
    e.preventDefault();
    onPreview();
  });

  $("cr_btn").addEventListener("click", (e) => {
    e.preventDefault();
    onRedeem();
  });
})();
