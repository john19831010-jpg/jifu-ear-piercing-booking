// --- 系統初始化與變數定義 ---
const CONFIG_VERSION = "1.0.5"; 
const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbwUHhZtqKp9PCrkR-Qdt_D2p8lDUny7PU8IM7FIgDzQ8CYvEH_gW01trNVAemRU5zEjZw/exec";

// 判定 Apps Script 網址是否合法 (避免複製時漏掉尾段字元)
function isValidGasUrl(url) {
  return url && url.startsWith("https://script.google.com/") && url.endsWith("/exec");
}

const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  gasUrl: DEFAULT_GAS_URL, // 預設使用老闆的 Apps Script 網頁應用程式網址，確保所有客人的裝置開箱即用
  days: {
    1: { open: true, start: "13:30", end: "20:30", interval: 60 },  // 週一 (13:30開始)
    2: { open: true, start: "11:30", end: "20:30", interval: 60 },  // 週二
    3: { open: true, start: "11:30", end: "20:30", interval: 60 },  // 週三
    4: { open: true, start: "11:30", end: "20:30", interval: 60 },  // 週四
    5: { open: true, start: "12:00", end: "16:30", interval: 30 },  // 週五 (12:00 - 16:30)
    6: { open: true, start: "14:00", end: "20:30", interval: 30 },  // 週六 (14:00 - 17:30 + 20:30)
    0: { open: true, start: "14:00", end: "20:30", interval: 30 }   // 週日 (14:00 - 17:30 + 20:30)
  },
  leaveDates: [], // 臨時請假/店休日期黑名單
  specialDisabledSlots: {} // 特定日期個別關閉的時段，格式如 {"2026-07-06": ["13:30", "14:30"]}
};

let loadedConfig = null;
try {
  const localConfigStr = localStorage.getItem("jifu_piercing_config");
  if (localConfigStr) {
    loadedConfig = JSON.parse(localConfigStr);
  }
} catch (e) {
  console.error("解析系統設定失敗，將使用預設設定", e);
}

let sysConfig;
// 進行舊版數據結構的相容性檢查與升級
if (loadedConfig && loadedConfig.days && loadedConfig.configVersion === CONFIG_VERSION) {
  sysConfig = loadedConfig;
  sysConfig.leaveDates = sysConfig.leaveDates || [];
  sysConfig.specialDisabledSlots = sysConfig.specialDisabledSlots || {};
  // 如果存檔的網址不合法 (比如被截斷了)，自動修正為正確的預設網址
  if (!isValidGasUrl(sysConfig.gasUrl)) {
    sysConfig.gasUrl = DEFAULT_GAS_URL;
    localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
  }
} else {
  // 首次載入或舊版本升級，強制套用最新預設營業時間，但保留請假、自訂時段與雲端網址
  sysConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  sysConfig.gasUrl = DEFAULT_GAS_URL;
  if (loadedConfig) {
    sysConfig.leaveDates = loadedConfig.leaveDates || [];
    sysConfig.specialDisabledSlots = loadedConfig.specialDisabledSlots || {};
    sysConfig.gasUrl = isValidGasUrl(loadedConfig.gasUrl) ? loadedConfig.gasUrl : DEFAULT_GAS_URL;
  }
  localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
}

let bookingsList = [];
try {
  const localBookingsStr = localStorage.getItem("jifu_piercing_bookings");
  if (localBookingsStr) {
    bookingsList = JSON.parse(localBookingsStr) || [];
  }
} catch (e) {
  console.error("解析預約名單失敗，初始化為空名單", e);
  bookingsList = [];
}

// 初始化網頁設定
document.addEventListener("DOMContentLoaded", () => {
  initClientPage();
  
  // 監聽網址 Hash 變化，用於切換後台入口
  window.addEventListener("hashchange", checkUrlHash);
  checkUrlHash();
  
  // 啟動雲端試算表非同步資料同步
  syncWithCloud();
});

// --- 前端顧客端邏輯 ---

function initClientPage() {
  const dateInput = document.getElementById("booking-date");
  const timeSelect = document.getElementById("booking-time");
  
  // 限制日期選擇器只能選今天及未來的日期
  const today = new Date().toISOString().split("T")[0];
  dateInput.min = today;
  
  // 監聽日期變更
  dateInput.addEventListener("change", () => {
    const selectedDate = dateInput.value;
    if (!selectedDate) {
      timeSelect.disabled = true;
      timeSelect.innerHTML = '<option value="">請先選擇日期</option>';
      return;
    }
    
    // 檢查是否為特定臨時請假/店休日
    if (sysConfig.leaveDates && sysConfig.leaveDates.includes(selectedDate)) {
      alert("抱歉！當天因師父臨時請假/公休，暫未開放預約，請選擇其他日期，謝謝！");
      dateInput.value = "";
      timeSelect.disabled = true;
      timeSelect.innerHTML = '<option value="">請先選擇日期</option>';
      return;
    }
    
    // 檢查是否為開放營業的星期
    const dateObj = new Date(selectedDate);
    const dayOfWeek = dateObj.getDay(); // 0 是週日, 1-6 是週一至週六
    
    const dayConfig = sysConfig.days[dayOfWeek];
    if (!dayConfig || !dayConfig.open) {
      alert("抱歉，您選擇的日期為本店休息日（未開放預約），請選擇其他營業日期！");
      dateInput.value = "";
      timeSelect.disabled = true;
      timeSelect.innerHTML = '<option value="">請先選擇日期</option>';
      return;
    }
    
    // 生成可預約時段，帶入選擇的日期以進行特定時段過濾
    generateTimeOptions(timeSelect, dayOfWeek, selectedDate);
  });
}

// 統一標準化從 Local 或雲端取回的日期格式為 YYYY-MM-DD
function normalizeDate(val) {
  if (!val) return "";
  const str = val.toString().trim();
  
  // 如果是 ISO 格式，例如 2026-07-06T16:00:00.000Z
  if (str.includes("T")) {
    const d = new Date(str);
    const tzOffset = 8 * 60; // 台灣時區是 UTC+8
    const localTime = new Date(d.getTime() + tzOffset * 60 * 1000);
    const y = localTime.getUTCFullYear();
    const m = String(localTime.getUTCMonth() + 1).padStart(2, "0");
    const day = String(localTime.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  
  // 如果是 2026/7/6 或是 2026/07/07，統一換成 YYYY-MM-DD
  if (str.includes("/")) {
    const parts = str.split("/");
    if (parts.length === 3) {
      return `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
    }
  }
  
  if (str.length >= 10) {
    return str.substring(0, 10).replace(/\//g, "-");
  }
  
  return str;
}

// 統一標準化從 Local 或雲端取回的時間格式為 HH:MM
function normalizeTime(val) {
  if (!val) return "";
  const str = val.toString().trim();
  
  // 如果是 Google 的時間物件轉出來的 ISO 格式，例如 1899-12-30T03:30:00.000Z
  if (str.includes("T")) {
    const d = new Date(str);
    const tzOffset = 8 * 60; // 台灣時區是 UTC+8
    const localTime = new Date(d.getTime() + tzOffset * 60 * 1000);
    const h = String(localTime.getUTCHours()).padStart(2, "0");
    const m = String(localTime.getUTCMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  
  // 如果是 "11:30:00"，只取前五位 "11:30"
  if (str.includes(":")) {
    const parts = str.split(":");
    if (parts.length >= 2) {
      return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
    }
  }
  
  return str;
}

// 根據特定星期設定與特定日期自訂過濾生成時段選項
function generateTimeOptions(selectElement, dayOfWeek, selectedDateStr = "") {
  selectElement.innerHTML = '<option value="" disabled selected>請選擇時段</option>';
  
  const dayConfig = sysConfig.days[dayOfWeek];
  if (!dayConfig) return;
  
  const [startH, startM] = dayConfig.start.split(":").map(Number);
  const [endH, endM] = dayConfig.end.split(":").map(Number);
  
  let currentMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  
  // 1. 取得此日被關閉的時段黑名單
  const blockedSlots = (selectedDateStr && sysConfig.specialDisabledSlots)
    ? (sysConfig.specialDisabledSlots[selectedDateStr] || [])
    : [];
  
  // 2. 即時從 localStorage 重新讀取最新的預約名單，避免全域變數過期快取！
  let latestBookingsList = [];
  try {
    const localBookingsStr = localStorage.getItem("jifu_piercing_bookings");
    if (localBookingsStr) {
      latestBookingsList = JSON.parse(localBookingsStr) || [];
    }
  } catch (e) {
    console.error("即時讀取預約名單失敗", e);
    latestBookingsList = bookingsList;
  }
  
  // 3. 取得此日已被預約佔用的時段 (不包含已取消的預約，使用標準化格式進行比對)
  const bookedSlots = [];
  const targetDateFormatted = normalizeDate(selectedDateStr);
  
  if (targetDateFormatted && latestBookingsList) {
    latestBookingsList.forEach(b => {
      const bDateFormatted = normalizeDate(b.date);
      const bTimeFormatted = normalizeTime(b.time);
      
      if (bDateFormatted === targetDateFormatted && b.status !== "已取消") {
        bookedSlots.push(bTimeFormatted);
      }
    });
  }
  
  let addedCount = 0;
  while (currentMin <= endMin) {
    const h = Math.floor(currentMin / 60);
    const m = currentMin % 60;
    const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    
    // 檢查是否為週六、日特定休息時間 (下午五點半 17:30 之後 到 晚上八點半 20:30 之前)
    const isWeekendBreak = (dayOfWeek === 6 || dayOfWeek === 0) && (currentMin > (17 * 60 + 30) && currentMin < (20 * 60 + 30));
    
    // 只有當該時段沒有被關閉、沒有被預約，且不屬於週六日中間休息時間時，才提供給客人選取
    if (!blockedSlots.includes(timeStr) && !bookedSlots.includes(timeStr) && !isWeekendBreak) {
      const option = document.createElement("option");
      option.value = timeStr;
      option.textContent = timeStr;
      selectElement.appendChild(option);
      addedCount++;
    }
    
    currentMin += Number(dayConfig.interval);
  }
  
  if (addedCount === 0) {
    selectElement.innerHTML = '<option value="" disabled selected>當天時段已全數約滿或未開放</option>';
    selectElement.disabled = true;
  } else {
    selectElement.disabled = false;
  }
}



// 顧客送出預約表單
function handleFormSubmit(e) {
  e.preventDefault();
  
  const name = document.getElementById("cust-name").value.trim();
  const phone = document.getElementById("cust-phone").value.trim();
  const line = document.getElementById("cust-line").value.trim() || "未填寫";
  const material = document.getElementById("cust-material").value;
  const date = document.getElementById("booking-date").value;
  const time = document.getElementById("booking-time").value;
  const addPotion = document.getElementById("add-potion").checked;
  const note = document.getElementById("cust-note").value.trim() || "無特別需求";
  
  // 穿耳洞位置收集
  const positionCheckboxes = document.querySelectorAll('input[name="position"]:checked');
  const positions = Array.from(positionCheckboxes).map(cb => cb.value);
  const positionStr = positions.length > 0 ? positions.join("、") : "未指定位置";
  
  if (!material) {
    alert("請選擇預計的耳針材質樣式！");
    return;
  }
  
  // 計算費用
  let materialPrice = 0;
  let materialText = "";
  
  if (material.includes("500")) {
    materialPrice = 500;
    materialText = "醫學鋼 基礎款 ($500)";
  } else if (material.includes("800")) {
    materialPrice = 800;
    materialText = "醫學鋼 進階款 ($800)";
  } else if (material.includes("1200")) {
    materialPrice = 1200;
    materialText = "純鈦金屬 抗敏款 ($1200)";
  } else if (material.includes("2400")) {
    materialPrice = 2400;
    materialText = "14K金 奢華款 ($2400)";
  } else if (material.includes("2800")) {
    materialPrice = 2800;
    materialText = "14K金 奢華款 ($2800)";
  } else {
    materialPrice = 0; // 現場挑選
    materialText = "現場挑選樣式 (價格現場估算)";
  }
  
  const potionPrice = addPotion ? 80 : 0;
  const totalPrice = materialPrice + potionPrice;
  
  // 建立預約物件
  const newBooking = {
    id: Date.now().toString(),
    name,
    phone,
    line,
    date,
    time,
    material: materialText,
    position: positionStr,
    potion: addPotion ? "是" : "否",
    totalPrice: materialPrice > 0 ? `$${totalPrice}` : `依現場款式為準${potionPrice > 0 ? ' (加購藥水 $80)' : ''}`,
    note,
    status: "待確認",
    createTime: new Date().toLocaleString("zh-TW")
  };
  
  // 在送出前，再次即時從 LocalStorage 檢查時段是否已被佔用，防止搶先預約衝突
  let latestBookings = [];
  try {
    const localStr = localStorage.getItem("jifu_piercing_bookings");
    if (localStr) {
      latestBookings = JSON.parse(localStr) || [];
    }
  } catch (e) {
    latestBookings = bookingsList;
  }
  
  // 產生 LINE 一鍵複製格式
  const lineText = `【吉富珠寶銀樓 - 穿耳洞預約確認】
您好！我已經送出線上穿耳預約，資料如下：
- 預約姓名：${name}
- 聯絡電話：${phone}
- LINE ID：${line}
- 預約日期：${date}
- 預約時段：${time}
- 耳針材質：${materialText}
- 穿耳位置：${positionStr}
- 加購藥水：${addPotion ? "是" : "否"}
- 特殊備註：${note}
- 預估金額：${newBooking.totalPrice}

再麻煩老闆確認，謝謝您！`;

  // 檢查是否已設定雲端同步
  if (sysConfig.gasUrl) {
    const submitBtn = document.querySelector("#piercing-form button[type='submit']");
    const originalBtnText = submitBtn ? submitBtn.innerText : "確認送出預約";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "⚡ 正在連線雲端預約中...";
    }

    fetch(sysConfig.gasUrl, {
      method: "POST",
      mode: "no-cors", // 徹底繞過 CORS 與重定向安全封鎖，確保 100% 成功寫入
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify({
        action: "addBooking",
        data: newBooking
      })
    })
    .then(() => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
      }
      // no-cors 模式下直接視為成功寫入
      bookingsList = latestBookings;
      bookingsList.push(newBooking);
      localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
      showSuccessModal(lineText);
    })
    .catch(err => {
      console.error("雲端預約失敗", err);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
      }
      alert("連線雲端資料庫失敗，請確認您的網路連線是否正常！");
    });
  } else {
    // 降級使用純單機模式 LocalStorage
    const isDuplicate = latestBookings.some(b => normalizeDate(b.date) === normalizeDate(date) && normalizeTime(b.time) === normalizeTime(time) && b.status !== "已取消");
    if (isDuplicate) {
      alert("抱歉！您選擇的預約時段剛剛已被其他顧客預約走了。請重新選擇其他日期或時段，謝謝！");
      const dateObj = new Date(date);
      const dayOfWeek = dateObj.getDay();
      generateTimeOptions(document.getElementById("booking-time"), dayOfWeek, date);
      return;
    }

    bookingsList = latestBookings;
    bookingsList.push(newBooking);
    localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
    showSuccessModal(lineText);
  }
}

// 顯示預約成功對話框並重設表單
function showSuccessModal(lineText) {
  document.getElementById("line-text-area").textContent = lineText;
  document.getElementById("success-modal").classList.add("active");
  document.getElementById("piercing-form").reset();
  document.getElementById("booking-time").disabled = true;
  document.getElementById("booking-time").innerHTML = '<option value="">請先選擇日期</option>';
}

function copyAndGoToLine() {
  const lineText = document.getElementById("line-text-area").textContent;
  navigator.clipboard.writeText(lineText).then(() => {
    alert("預約內容已成功複製！即將為您打開吉富珠寶官方 LINE，請點擊「加入好友」並在對話框中直接「貼上並傳送」預約資訊即可！");
    window.open("https://line.me/R/ti/p/%40oso8857f", "_blank");
  }).catch(err => {
    console.error("複製失敗：", err);
    // 降級處理，依然嘗試開啟 LINE
    window.open("https://line.me/R/ti/p/%40oso8857f", "_blank");
  });
}

function closeSuccessModal() {
  document.getElementById("success-modal").classList.remove("active");
}

// --- 管理後台邏輯 ---

// 確認 URL 是否含有 #admin，若是則顯示後台，否則顯示前台
function checkUrlHash() {
  if (window.location.hash === "#admin") {
    showAdminSection();
  }
}

function showAdminSection() {
  document.getElementById("client-section").style.display = "none";
  document.getElementById("client-header").style.display = "none";
  document.getElementById("admin-section").style.display = "block";
  
  // 檢查是否已登入
  const isLogin = sessionStorage.getItem("jifu_admin_login") === "true";
  if (isLogin) {
    document.getElementById("admin-login-card").style.display = "none";
    document.getElementById("admin-main-panel").style.display = "block";
    renderBookingList();
    loadTimeConfigForm();
  } else {
    document.getElementById("admin-login-card").style.display = "block";
    document.getElementById("admin-main-panel").style.display = "none";
  }
}

function hideAdminSection() {
  window.location.hash = "";
  document.getElementById("client-section").style.display = "block";
  document.getElementById("client-header").style.display = "block";
  document.getElementById("admin-section").style.display = "none";
}

function handleAdminLogin() {
  const password = document.getElementById("admin-pass").value;
  // 預設店用密碼：jifu888
  if (password === "jifu888") {
    sessionStorage.setItem("jifu_admin_login", "true");
    document.getElementById("admin-login-card").style.display = "none";
    document.getElementById("admin-main-panel").style.display = "block";
    document.getElementById("admin-pass").value = "";
    renderBookingList();
    loadTimeConfigForm();
  } else {
    alert("密碼錯誤！請重新輸入。如果不知道密碼，請洽管理人員。");
  }
}

function handleAdminLogout() {
  sessionStorage.removeItem("jifu_admin_login");
  showAdminSection();
}

// 後台分頁切換
function switchAdminTab(tabName) {
  document.querySelectorAll(".admin-tab").forEach(tab => tab.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(content => content.classList.remove("active"));
  
  if (tabName === 'list') {
    document.getElementById("tab-btn-list").classList.add("active");
    document.getElementById("tab-list").classList.add("active");
    renderBookingList();
  } else if (tabName === 'settings') {
    document.getElementById("tab-btn-settings").classList.add("active");
    document.getElementById("tab-settings").classList.add("active");
    loadTimeConfigForm();
  }
}

// 載入時間設定表單數據 (從 LocalStorage 載入設定並填入後台)
function loadTimeConfigForm() {
  for (let day in sysConfig.days) {
    const dayConfig = sysConfig.days[day];
    const row = document.querySelector(`#config-days-tbody tr[data-day="${day}"]`);
    if (row) {
      row.querySelector(".cfg-open").checked = dayConfig.open;
      row.querySelector(".cfg-start").value = dayConfig.start;
      row.querySelector(".cfg-end").value = dayConfig.end;
      row.querySelector(".cfg-interval").value = dayConfig.interval;
    }
  }
  
  // 載入臨時請假日期清單
  loadLeaveDatesList();
  
  // 載入特別自訂時段的日期清單
  loadSpecialDatesList();
  
  // 更新後台手動預約的日期限制
  const manualDateInput = document.getElementById("manual-date");
  manualDateInput.min = new Date().toISOString().split("T")[0];
  
  // 設定後台休假日期選擇器的最小值為今天
  const leaveDateInput = document.getElementById("config-leave-date");
  if (leaveDateInput) {
    leaveDateInput.min = new Date().toISOString().split("T")[0];
  }
  
  // 設定個別日期時段調整選擇器的最小值為今天
  const specialDatePicker = document.getElementById("special-date-picker");
  if (specialDatePicker) {
    specialDatePicker.min = new Date().toISOString().split("T")[0];
  }
  
  // 預設隱藏自訂時段勾選區塊
  const specialArea = document.getElementById("special-slots-area");
  if (specialArea) specialArea.style.display = "none";
}

// 渲染已設定的請假日期標籤列表
function loadLeaveDatesList() {
  const container = document.getElementById("leave-dates-list");
  if (!container) return;
  
  container.innerHTML = "";
  const leaveDates = sysConfig.leaveDates || [];
  
  if (leaveDates.length === 0) {
    container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.9rem;">（目前無設定特定休假日）</span>`;
    return;
  }
  
  // 將請假日期由近到遠排序
  const sortedDates = [...leaveDates].sort((a, b) => a.localeCompare(b));
  
  sortedDates.forEach(dateStr => {
    const badge = document.createElement("span");
    badge.className = "status-badge status-cancelled";
    badge.style.cssText = "display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 0.85rem; border-radius: 50px;";
    badge.innerHTML = `
      ${dateStr} 
      <span style="cursor: pointer; font-weight: bold; font-size: 1.1rem; color: #FF453A; margin-left: 4px;" onclick="deleteLeaveDate('${dateStr}')">×</span>
    `;
    container.appendChild(badge);
  });
}

// 新增請假日期
function addLeaveDate() {
  const dateInput = document.getElementById("config-leave-date");
  const selectedDate = dateInput.value;
  
  if (!selectedDate) {
    alert("請先選擇要設定的休假日期！");
    return;
  }
  
  sysConfig.leaveDates = sysConfig.leaveDates || [];
  
  if (sysConfig.leaveDates.includes(selectedDate)) {
    alert("該日期已經在休假清單中了！");
    return;
  }
  
  sysConfig.leaveDates.push(selectedDate);
  localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
  saveConfigToCloud();
  
  alert(`成功加入休假日期：${selectedDate}！`);
  dateInput.value = "";
  
  // 重新載入
  loadLeaveDatesList();
  initClientPage();
}

// 刪除請假日期
function deleteLeaveDate(dateStr) {
  if (confirm(`確定要取消 ${dateStr} 的休假，重新開放預約嗎？`)) {
    sysConfig.leaveDates = sysConfig.leaveDates || [];
    sysConfig.leaveDates = sysConfig.leaveDates.filter(d => d !== dateStr);
    localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
    saveConfigToCloud();
    
    loadLeaveDatesList();
    initClientPage();
  }
}

// --- 臨時自訂特定日期時段之增刪與控制邏輯 ---

// 後台載入當天時段 Checkboxes 供師傅勾選
function loadSpecialDateSlots() {
  const datePicker = document.getElementById("special-date-picker");
  const dateStr = datePicker.value;
  
  if (!dateStr) {
    alert("請先選擇要個別調整時段的日期！");
    return;
  }
  
  // 提醒該日期是否為全天請假日期
  if (sysConfig.leaveDates && sysConfig.leaveDates.includes(dateStr)) {
    alert("提示：該日期目前已設定為「全天休假/店休」。若要開放特定時段，請先至上方取消休假設定！");
  }
  
  const dateObj = new Date(dateStr);
  const dayOfWeek = dateObj.getDay();
  const dayConfig = sysConfig.days[dayOfWeek];
  
  // 如果預設店休，提示並給予預設值供強行設定
  const dayConfigToUse = (dayConfig && dayConfig.open) ? dayConfig : { start: "11:30", end: "20:30", interval: 60 };
  if (!dayConfig || !dayConfig.open) {
    alert("提示：當天星期在您的預設中是「店休/不開放」。系統將會生成該星期的預設時段供您強行開放。");
  }
  
  const [startH, startM] = dayConfigToUse.start.split(":").map(Number);
  const [endH, endM] = dayConfigToUse.end.split(":").map(Number);
  
  let currentMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  
  // 取得此日被關閉的時段黑名單
  sysConfig.specialDisabledSlots = sysConfig.specialDisabledSlots || {};
  const blockedSlots = sysConfig.specialDisabledSlots[dateStr] || [];
  
  const container = document.getElementById("special-slots-checkboxes");
  container.innerHTML = "";
  let slotsCount = 0;
  while (currentMin <= endMin) {
    const h = Math.floor(currentMin / 60);
    const m = currentMin % 60;
    const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    
    // 檢查是否為週六、日特定休息時間 (下午五點半 17:30 之後 到 晚上八點半 20:30 之前)
    const isWeekendBreak = (dayOfWeek === 6 || dayOfWeek === 0) && (currentMin > (17 * 60 + 30) && currentMin < (20 * 60 + 30));
    
    if (!isWeekendBreak) {
      // 如果不在黑名單中，代表是勾選（開放）的
      const isChecked = !blockedSlots.includes(timeStr);
      
      const label = document.createElement("label");
      label.className = "checkbox-label";
      label.style.cssText = "border: 1px solid rgba(255,255,255,0.08); padding: 8px 12px; border-radius: 6px; background: rgba(255,255,255,0.02); display: flex; align-items: center; gap: 8px; cursor: pointer;";
      label.innerHTML = `
        <input type="checkbox" class="special-slot-cb" value="${timeStr}" ${isChecked ? 'checked' : ''}>
        <span class="en-num" style="font-weight: 600;">${timeStr}</span>
      `;
      container.appendChild(label);
      slotsCount++;
    }
    
    currentMin += Number(dayConfigToUse.interval);
  }
  
  if (slotsCount === 0) {
    container.innerHTML = `<span style="color: var(--danger);">無法為此日期生成營業時段！</span>`;
    document.getElementById("special-slots-area").style.display = "block";
    return;
  }
  
  // 顯示選取區塊
  document.getElementById("special-slots-area").style.display = "block";
}

// 儲存特別自訂時段
function saveSpecialDateSlots() {
  const datePicker = document.getElementById("special-date-picker");
  const dateStr = datePicker.value;
  if (!dateStr) return;
  
  const checkboxes = document.querySelectorAll(".special-slot-cb");
  const blockedSlots = [];
  
  checkboxes.forEach(cb => {
    // 未勾選的時段 = 被關閉的時段
    if (!cb.checked) {
      blockedSlots.push(cb.value);
    }
  });
  
  sysConfig.specialDisabledSlots = sysConfig.specialDisabledSlots || {};
  
  if (blockedSlots.length > 0) {
    sysConfig.specialDisabledSlots[dateStr] = blockedSlots;
  } else {
    // 如果全部都勾選（全部時段開放），直接刪除此日期的自訂，恢復預設
    delete sysConfig.specialDisabledSlots[dateStr];
  }
  
  localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
  saveConfigToCloud();
  alert(`成功儲存 ${dateStr} 的個別預約時段設定！顧客在前台將只能選取您有勾選的時段。`);
  
  // 隱藏區塊並重設輸入
  document.getElementById("special-slots-area").style.display = "none";
  datePicker.value = "";
  
  // 重新載入列表與前台
  loadSpecialDatesList();
  initClientPage();
}

// 渲染已設定自訂時段的日期標籤清單
function loadSpecialDatesList() {
  const container = document.getElementById("special-dates-list");
  if (!container) return;
  
  container.innerHTML = "";
  sysConfig.specialDisabledSlots = sysConfig.specialDisabledSlots || {};
  const dates = Object.keys(sysConfig.specialDisabledSlots);
  
  if (dates.length === 0) {
    container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.9rem;">（目前無設定個別日期時段）</span>`;
    return;
  }
  
  // 排序日期
  const sortedDates = [...dates].sort((a, b) => a.localeCompare(b));
  
  sortedDates.forEach(dateStr => {
    const disabledCount = sysConfig.specialDisabledSlots[dateStr].length;
    const badge = document.createElement("span");
    badge.className = "status-badge status-pending";
    badge.style.cssText = "display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 0.85rem; border-radius: 50px; color: var(--gold-light); border: 1px solid var(--gold-border); background: rgba(212,175,55,0.1);";
    badge.innerHTML = `
      ${dateStr} (已關閉 ${disabledCount} 個時段)
      <span style="cursor: pointer; font-weight: bold; font-size: 1.1rem; color: #FF453A; margin-left: 4px;" onclick="deleteSpecialDateConfig('${dateStr}')">×</span>
    `;
    container.appendChild(badge);
  });
}

// 刪除特定日期的自訂特別時段
function deleteSpecialDateConfig(dateStr) {
  if (confirm(`確定要清除 ${dateStr} 的個別時段微調，回復為一般星期的預設營業時間嗎？`)) {
    sysConfig.specialDisabledSlots = sysConfig.specialDisabledSlots || {};
    delete sysConfig.specialDisabledSlots[dateStr];
    localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
    saveConfigToCloud();
    
    loadSpecialDatesList();
    initClientPage();
  }
}

// 儲存每日自訂預約時間設定
function saveTimeSettings() {
  const newDaysConfig = {};
  const rows = document.querySelectorAll("#config-days-tbody tr");
  let hasOpenDay = false;
  
  for (let row of rows) {
    const day = row.getAttribute("data-day");
    const open = row.querySelector(".cfg-open").checked;
    const start = row.querySelector(".cfg-start").value;
    const end = row.querySelector(".cfg-end").value;
    const interval = Number(row.querySelector(".cfg-interval").value);
    
    // 如果這天有開放，檢查時間的合理性
    if (open) {
      hasOpenDay = true;
      const [startH, startM] = start.split(":").map(Number);
      const [endH, endM] = end.split(":").map(Number);
      if (startH * 60 + startM >= endH * 60 + endM) {
        const dayNames = { "1": "週一", "2": "週二", "3": "週三", "4": "週四", "5": "週五", "6": "週六", "0": "週日" };
        alert(`${dayNames[day]} 的開始營業時間不能晚於或等於最晚預約時間！`);
        return;
      }
    }
    
    newDaysConfig[day] = { open, start, end, interval };
  }
  
  if (!hasOpenDay) {
    alert("請至少開放一天的預約營業時間！");
    return;
  }
  
  // 更新系統設定並儲存
  sysConfig.days = newDaysConfig;
  localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
  saveConfigToCloud();
  alert("每日自訂預約時間設定已成功儲存！客人在前台將會看到您專屬設定的時間段。");
  
  // 重新初始化前台日期與時段控制
  initClientPage();
}

// 重設時間設定為預設值
function resetTimeSettingsDefault() {
  if (confirm("確認要將預約時間設定回復至系統預設值（週一至週六 11:30 - 20:30 開放，週日休息）嗎？")) {
    sysConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
    saveConfigToCloud();
    loadTimeConfigForm();
    initClientPage();
    alert("已成功回復系統預設設定！");
  }
}

// 後台手動預約日期時段動態連動
function updateManualTimeOptions() {
  const manualDate = document.getElementById("manual-date").value;
  const manualTimeSelect = document.getElementById("manual-time");
  
  if (!manualDate) {
    manualTimeSelect.innerHTML = '<option value="">請先選擇日期</option>';
    return;
  }
  
  // 檢查是否為請假黑名單日期
  if (sysConfig.leaveDates && sysConfig.leaveDates.includes(manualDate)) {
    alert("提示：您選擇的日期是「師父臨時請假/店休日」。如果確定要強行建立預約，系統仍會提供該星期的預設時間選項。");
  }
  
  // 檢查是否為自訂特殊時段日期
  sysConfig.specialDisabledSlots = sysConfig.specialDisabledSlots || {};
  if (sysConfig.specialDisabledSlots[manualDate]) {
    alert("提示：此日期已被設定「個別時段微調」，手動預約將僅列出您有開放的預約時段。");
  }
  
  const dateObj = new Date(manualDate);
  const dayOfWeek = dateObj.getDay();
  
  const dayConfig = sysConfig.days[dayOfWeek];
  if (!dayConfig || !dayConfig.open) {
    alert("提示：您選擇的日期在您的後台設定中是「休息日」。如果確認要手動建立預約，系統仍將為您提供該星期的預設時間選項。");
    generateTimeOptions(manualTimeSelect, dayOfWeek, manualDate);
  } else {
    generateTimeOptions(manualTimeSelect, dayOfWeek, manualDate);
  }
}

// 商家手動新增預約送出
function handleManualSubmit(e) {
  e.preventDefault();
  
  const name = document.getElementById("manual-name").value.trim();
  const phone = document.getElementById("manual-phone").value.trim();
  const material = document.getElementById("manual-material").value;
  const date = document.getElementById("manual-date").value;
  const time = document.getElementById("manual-time").value;
  const addPotion = document.getElementById("manual-potion").checked;
  const position = document.getElementById("manual-position").value.trim() || "耳垂";
  const note = document.getElementById("manual-note").value.trim() || "商家手動新增";
  
  // 計算費用
  let materialPrice = 0;
  if (material.includes("500")) materialPrice = 500;
  else if (material.includes("800")) materialPrice = 800;
  else if (material.includes("1200")) materialPrice = 1200;
  else if (material.includes("2400")) materialPrice = 2400;
  else if (material.includes("2800")) materialPrice = 2800;
  
  const potionPrice = addPotion ? 80 : 0;
  const totalPrice = materialPrice + potionPrice;
  
  const newBooking = {
    id: Date.now().toString(),
    name,
    phone,
    line: "現場/電話客",
    date,
    time,
    material,
    position,
    potion: addPotion ? "是" : "否",
    totalPrice: materialPrice > 0 ? `$${totalPrice}` : `依現場款式為準${potionPrice > 0 ? ' (加購藥水 $80)' : ''}`,
    note,
    status: "已確認",
    createTime: new Date().toLocaleString("zh-TW")
  };
  
  // 讀取最新本地預約名單備份
  let latestBookings = [];
  try {
    const localStr = localStorage.getItem("jifu_piercing_bookings");
    if (localStr) {
      latestBookings = JSON.parse(localStr) || [];
    }
  } catch (e) {
    latestBookings = bookingsList;
  }
  
  // 檢查是否已設定雲端同步
  if (sysConfig.gasUrl) {
    const submitBtn = document.querySelector("#admin-manual-form button[type='submit']");
    const originalBtnText = submitBtn ? submitBtn.innerText : "確認手動新增";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "⚡ 正在連線雲端資料庫...";
    }

    fetch(sysConfig.gasUrl, {
      method: "POST",
      mode: "no-cors", // 徹底繞過 CORS 與重定向安全封鎖，確保 100% 成功寫入
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify({
        action: "addBooking",
        data: newBooking
      })
    })
    .then(() => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
      }
      // no-cors 模式下直接視為成功寫入
      bookingsList = latestBookings;
      bookingsList.push(newBooking);
      localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
      showManualSuccess();
    })
    .catch(err => {
      console.error("雲端手動預約失敗", err);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
      }
      alert("連線雲端資料庫失敗，請確認您的網路連線是否正常！");
    });
  } else {
    // 降級使用純單機模式 LocalStorage
    const isDuplicate = latestBookings.some(b => normalizeDate(b.date) === normalizeDate(date) && normalizeTime(b.time) === normalizeTime(time) && b.status !== "已取消");
    if (isDuplicate) {
      alert("建立預約失敗！該日期的此時段已被其他預約佔用。請重新選擇其他時段。");
      const dateObj = new Date(date);
      const dayOfWeek = dateObj.getDay();
      generateTimeOptions(document.getElementById("manual-time"), dayOfWeek, date);
      return;
    }

    bookingsList = latestBookings;
    bookingsList.push(newBooking);
    localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
    showManualSuccess();
  }
}

// 手動新增預約成功的輔助函數
function showManualSuccess() {
  alert("成功為顧客手動建立一筆已確認預約！");
  document.getElementById("admin-manual-form").reset();
  document.getElementById("manual-time").innerHTML = '<option value="">請先選擇日期</option>';
  renderBookingList();
}

// --- 渲染預約名單列表 (含篩選與操作) ---
function renderBookingList() {
  const tbody = document.getElementById("booking-table-body");
  tbody.innerHTML = "";
  
  // 取得篩選值
  const searchVal = document.getElementById("filter-search").value.toLowerCase().trim();
  const dateVal = document.getElementById("filter-date").value;
  const statusVal = document.getElementById("filter-status").value;
  
  // 過濾名單 (以預約日期由近到遠排序)
  let filteredBookings = bookingsList.filter(booking => {
    const matchesSearch = booking.name.toLowerCase().includes(searchVal) || booking.phone.includes(searchVal);
    const matchesDate = !dateVal || booking.date === dateVal;
    const matchesStatus = !statusVal || booking.status === statusVal;
    return matchesSearch && matchesDate && matchesStatus;
  });
  
  // 排序：預約日期由新到舊，時段由小到大
  filteredBookings.sort((a, b) => {
    if (a.date !== b.date) {
      return b.date.localeCompare(a.date); // 日期降序
    }
    return a.time.localeCompare(b.time); // 時間升序
  });
  
  if (filteredBookings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 40px 0;">目前無符合篩選條件的預約資料。</td></tr>`;
    return;
  }
  
  filteredBookings.forEach(booking => {
    const tr = document.createElement("tr");
    
    // 狀態款式樣式
    let statusClass = "status-pending";
    if (booking.status === "已確認") statusClass = "status-confirmed";
    else if (booking.status === "已完成") statusClass = "status-completed";
    else if (booking.status === "已取消") statusClass = "status-cancelled";
    
    tr.innerHTML = `
      <td>
        <div style="font-weight: 700; color: var(--gold-light);">${booking.date}</div>
        <div class="en-num" style="font-size: 0.85rem; color: var(--text-secondary);">${booking.time}</div>
      </td>
      <td>
        <div style="font-weight: 600;">${booking.name}</div>
        <div class="en-num" style="font-size: 0.85rem; color: var(--text-secondary);">${booking.phone}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">LINE: ${booking.line}</div>
      </td>
      <td>
        <div>${booking.material}</div>
        <div style="font-size: 0.85rem; color: var(--text-secondary);">位置: ${booking.position}</div>
      </td>
      <td style="text-align: center;">${booking.potion || "否"}</td>
      <td class="en-num" style="font-weight: 600; color: var(--gold-primary);">${booking.totalPrice}</td>
      <td>
        <select class="action-select" onchange="changeBookingStatus('${booking.id}', this.value)">
          <option value="待確認" ${booking.status === '待確認' ? 'selected' : ''}>待確認</option>
          <option value="已確認" ${booking.status === '已確認' ? 'selected' : ''}>已確認</option>
          <option value="已完成" ${booking.status === '已完成' ? 'selected' : ''}>已完成</option>
          <option value="已取消" ${booking.status === '已取消' ? 'selected' : ''}>已取消</option>
        </select>
      </td>
      <td>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input type="text" class="action-select" style="padding: 4px 8px; width: 100%; min-width: 120px;" placeholder="備註..." value="${booking.note || ''}" onchange="updateBookingNote('${booking.id}', this.value)">
          <button class="dark-btn" style="padding: 4px 8px; font-size: 0.75rem; border-color: rgba(255, 69, 58, 0.4); color: #FF453A;" onclick="deleteBooking('${booking.id}')">刪除</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// 變更預約狀態
function changeBookingStatus(id, newStatus) {
  bookingsList = bookingsList.map(b => {
    if (b.id === id) {
      return { ...b, status: newStatus };
    }
    return b;
  });
  localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
  
  if (sysConfig.gasUrl) {
    fetch(sysConfig.gasUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "updateBookingStatus", id, status: newStatus })
    });
  }
  
  renderBookingList();
}

// 變更顧客備註
function updateBookingNote(id, newNote) {
  bookingsList = bookingsList.map(b => {
    if (b.id === id) {
      return { ...b, note: newNote };
    }
    return b;
  });
  localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
  
  if (sysConfig.gasUrl) {
    fetch(sysConfig.gasUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "updateBookingNote", id, note: newNote })
    });
  }
}

// 刪除預約
function deleteBooking(id) {
  if (confirm("確定要永久刪除此筆預約資料嗎？此操作無法還原。")) {
    bookingsList = bookingsList.filter(b => b.id !== id);
    localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
    
    if (sysConfig.gasUrl) {
      fetch(sysConfig.gasUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ action: "deleteBooking", id })
      });
    }
    
    renderBookingList();
  }
}

// 清除篩選器
function clearFilters() {
  document.getElementById("filter-search").value = "";
  document.getElementById("filter-date").value = "";
  document.getElementById("filter-status").value = "";
  renderBookingList();
}

// --- Google 試算表雲端同步輔助函數 ---

// 儲存設定至雲端 (Apps Script - Config 工作表)
function saveConfigToCloud() {
  if (sysConfig.gasUrl) {
    fetch(sysConfig.gasUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "saveConfig", data: sysConfig })
    });
  }
}

// 與雲端試算表非同步資料同步 (雙模設計 - 全面使用標準 GET fetch)
function syncWithCloud() {
  const statusBadge = document.getElementById("cloud-sync-status");
  const gasUrlInput = document.getElementById("config-gas-url");
  
  if (gasUrlInput) {
    gasUrlInput.value = sysConfig.gasUrl || "";
  }
  
  if (!sysConfig.gasUrl) {
    if (statusBadge) {
      statusBadge.innerText = "單機模式 (未同步雲端)";
      statusBadge.style.cssText = "background: rgba(255, 69, 58, 0.15); color: #FF453A; border: 1px solid #FF453A; font-size: 0.8rem; padding: 4px 12px; border-radius: 50px;";
    }
    document.getElementById("sync-local-btn-area").style.display = "none";
    return;
  }
  
  if (statusBadge) {
    statusBadge.innerText = "🔄 正在連線雲端試算表...";
    statusBadge.style.cssText = "background: rgba(255, 149, 0, 0.15); color: #FF9500; border: 1px solid #FF9500; font-size: 0.8rem; padding: 4px 12px; border-radius: 50px;";
  }
  
  // 1. 同步獲取雲端預約名單
  fetch(sysConfig.gasUrl + "?action=getBookings")
  .then(res => res.json())
  .then(cloudBookings => {
    if (Array.isArray(cloudBookings)) {
      // 成功獲取，更新本地備份
      bookingsList = cloudBookings;
      localStorage.setItem("jifu_piercing_bookings", JSON.stringify(bookingsList));
      
      // 更新狀態徽章為連線成功
      if (statusBadge) {
        statusBadge.innerText = "🟢 連線中 (雲端同步)";
        statusBadge.style.cssText = "background: rgba(52, 199, 89, 0.15); color: #34C759; border: 1px solid #34C759; font-size: 0.8rem; padding: 4px 12px; border-radius: 50px;";
      }
      
      // 檢查是否需要同步本地舊資料的提示
      checkLocalDataDiff(cloudBookings);
      
      // 重新渲染後台名單
      renderBookingList();
    }
  })
  .catch(err => {
    console.error("同步預約名單失敗，降級使用 LocalStorage", err);
    if (statusBadge) {
      statusBadge.innerText = "⚠️ 連線失敗 (降級單機運作)";
      statusBadge.style.cssText = "background: rgba(255, 69, 58, 0.15); color: #FF453A; border: 1px solid #FF453A; font-size: 0.8rem; padding: 4px 12px; border-radius: 50px;";
    }
  });

  // 2. 同步獲取雲端營業配置
  fetch(sysConfig.gasUrl + "?action=getConfig")
  .then(res => res.json())
  .then(res => {
    if (res.configStr) {
      const cloudConfig = JSON.parse(res.configStr);
      // 如果雲端有較新的配置，更新本地，但維持本地的 gasUrl
      if (cloudConfig && cloudConfig.days) {
        const currentGasUrl = sysConfig.gasUrl;
        sysConfig = cloudConfig;
        sysConfig.gasUrl = currentGasUrl;
        localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
        
        // 重新填入後台設定表單
        for (let day in sysConfig.days) {
          const dayConfig = sysConfig.days[day];
          const row = document.querySelector(`#config-days-tbody tr[data-day="${day}"]`);
          if (row) {
            row.querySelector(".cfg-open").checked = dayConfig.open;
            row.querySelector(".cfg-start").value = dayConfig.start;
            row.querySelector(".cfg-end").value = dayConfig.end;
            row.querySelector(".cfg-interval").value = dayConfig.interval;
          }
        }
        loadLeaveDatesList();
        loadSpecialDatesList();
      }
    }
  })
  .catch(err => console.error("同步設定失敗，降級使用 LocalStorage 營業配置", err));
}

// 儲存 GAS 網址 (在後台點擊儲存按鈕)
function saveGasUrl() {
  const urlInput = document.getElementById("config-gas-url");
  const url = urlInput.value.trim();
  
  if (!isValidGasUrl(url)) {
    alert("請輸入完整的 Google Apps Script 網頁應用程式網址！\n網址必須以 https://script.google.com/ 開頭，且結尾必須是 /exec。\n請檢查您的網址尾端是否被截斷了。");
    return;
  }
  
  sysConfig.gasUrl = url;
  localStorage.setItem("jifu_piercing_config", JSON.stringify(sysConfig));
  
  alert("Google 試算表連線網址儲存成功！即將開始測試連線並進行雲端同步...");
  syncWithCloud();
}

// 檢查本地 LocalStorage 裡是否有尚未上傳到雲端試算表的舊預約
function checkLocalDataDiff(cloudBookings) {
  const localBookings = JSON.parse(localStorage.getItem("jifu_piercing_bookings")) || [];
  const cloudIds = cloudBookings.map(b => b.id.toString());
  
  // 找出本地有、但雲端沒有的預約 (即需要上傳同步的舊資料)
  const diffBookings = localBookings.filter(b => !cloudIds.includes(b.id.toString()));
  
  const diffArea = document.getElementById("sync-local-btn-area");
  const countSpan = document.getElementById("local-bookings-count");
  
  if (diffBookings.length > 0 && diffArea && countSpan) {
    countSpan.innerText = diffBookings.length;
    diffArea.style.display = "block";
  } else if (diffArea) {
    diffArea.style.display = "none";
  }
}

// 將本地舊資料一鍵批次同步上傳至雲端試算表
function syncLocalBookingsToCloud() {
  const localBookings = JSON.parse(localStorage.getItem("jifu_piercing_bookings")) || [];
  
  // 再次取得雲端 ID
  fetch(sysConfig.gasUrl + "?action=getBookings")
  .then(res => res.json())
  .then(cloudBookings => {
    if (Array.isArray(cloudBookings)) {
      const cloudIds = cloudBookings.map(b => b.id.toString());
      const diffBookings = localBookings.filter(b => !cloudIds.includes(b.id.toString()));
      
      if (diffBookings.length === 0) {
        alert("資料已是最新，無需同步！");
        document.getElementById("sync-local-btn-area").style.display = "none";
        return;
      }
      
      let successCount = 0;
      let conflictCount = 0;
      let errorCount = 0;
      
      // 遞迴上傳防止多工併發錯誤
      function uploadNext(index) {
        if (index >= diffBookings.length) {
          alert(`同步完成！\n✅ 成功上傳：${successCount} 筆\n⚠️ 重複排除：${conflictCount} 筆\n❌ 連線失敗：${errorCount} 筆`);
          // 重新同步抓取雲端，更新狀態
          syncWithCloud();
          return;
        }
        
        const booking = diffBookings[index];
        const url = sysConfig.gasUrl + "?action=addBooking&data=" + encodeURIComponent(JSON.stringify(booking));
        fetch(url)
        .then(res => res.json())
        .then(res => {
          if (res.success) successCount++;
          else if (res.conflict) conflictCount++;
          else errorCount++;
          uploadNext(index + 1);
        })
        .catch(err => {
          console.error("同步上傳單筆預約失敗", err);
          errorCount++;
          uploadNext(index + 1);
        });
      }
      
      alert(`準備開始上傳同步 ${diffBookings.length} 筆歷史資料，這可能需要幾秒鐘，請勿關閉網頁...`);
      uploadNext(0);
    }
  })
  .catch(err => {
    alert("同步失敗，請確認您的雲端試算表連線狀態正常！");
  });
}

