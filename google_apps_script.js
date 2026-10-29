// google_apps_script.js
// 適用於「吉富珠寶銀樓穿耳預約系統」的雲端試算表資料庫轉接器
// 請複製整份檔案，並貼入您 Google 試算表的「擴充功能」->「Apps Script」中。

// 後台管理密碼（集中於伺服器端驗證，不在前端暴露）
var ADMIN_PASSWORD = "jifu888";

// 台北時區常數，確保時區解析 100% 準確
var TIMEZONE = "Asia/Taipei";

function doGet(e) {
  var action = e.parameter.action;
  var callback = e.parameter.callback; // 獲取 JSONP 回調函數名
  
  if (action === "getBookings") {
    // 支援以 adminPass 驗證；若提供正確密碼則回傳完整名單，否則只回傳脫敏後的時段資料
    var adminPass = e.parameter.adminPass;
    if (adminPass === ADMIN_PASSWORD) {
      return getFullBookings(callback);
    }
    return getPublicBookings(callback);
  } else if (action === "verifyAdmin") {
    var pass = e.parameter.password;
    if (pass === ADMIN_PASSWORD) {
      return createResponse({ success: true }, callback);
    }
    return createResponse({ success: false, error: "密碼錯誤" }, callback);
  } else if (action === "getConfig") {
    return getConfig(callback);
  } else if (action === "addBooking") {
    var rawData = e.parameter.data;
    var data = null;
    try {
      data = JSON.parse(rawData);
    } catch (err) {
      try {
        data = JSON.parse(decodeURIComponent(rawData));
      } catch (err2) {
        return createResponse({ success: false, error: "資料格式錯誤" }, callback);
      }
    }
    return addBooking(data, callback);
  } else if (action === "updateBookingStatus") {
    var id = e.parameter.id;
    var status = e.parameter.status;
    return updateBookingStatus(id, status, callback);
  } else if (action === "updateBookingNote") {
    var id = e.parameter.id;
    var note = e.parameter.note;
    return updateBookingNote(id, note, callback);
  } else if (action === "deleteBooking") {
    var id = e.parameter.id;
    return deleteBooking(id, callback);
  } else if (action === "saveConfig") {
    var rawData = e.parameter.data;
    var data = null;
    try {
      data = JSON.parse(rawData);
    } catch (err) {
      data = JSON.parse(decodeURIComponent(rawData));
    }
    return saveConfig(data, callback);
  }
  
  return createResponse({ error: "Invalid GET action" }, callback);
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (error) {
    return createResponse({ error: "Invalid JSON format" }, null);
  }
  
  var action = payload.action;
  
  if (action === "verifyAdmin") {
    if (payload.password === ADMIN_PASSWORD) {
      return createResponse({ success: true }, null);
    }
    return createResponse({ success: false, error: "密碼錯誤" }, null);
  } else if (action === "addBooking") {
    return addBooking(payload.data, null);
  } else if (action === "updateBookingStatus") {
    return updateBookingStatus(payload.id, payload.status, null);
  } else if (action === "updateBookingNote") {
    return updateBookingNote(payload.id, payload.note, null);
  } else if (action === "deleteBooking") {
    return deleteBooking(payload.id, null);
  } else if (action === "saveConfig") {
    return saveConfig(payload.data, null);
  }
  
  return createResponse({ error: "Invalid POST action" }, null);
}

// 標準化日期為 YYYY-MM-DD
function formatCellDate(val) {
  if (!val) return "";
  if (Object.prototype.toString.call(val) === "[object Date]" && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, TIMEZONE, "yyyy-MM-dd");
  }
  var s = val.toString().trim();
  if (s.indexOf("T") !== -1) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd");
    }
  }
  if (s.indexOf("/") !== -1) {
    var parts = s.split("/");
    if (parts.length === 3) {
      var y = parts[0];
      var m = parts[1].length === 1 ? "0" + parts[1] : parts[1];
      var day = parts[2].length === 1 ? "0" + parts[2] : parts[2];
      return y + "-" + m + "-" + day;
    }
  }
  if (s.length >= 10) {
    return s.substring(0, 10).replace(/\//g, "-");
  }
  return s;
}

// 標準化時間為 HH:mm
function formatCellTime(val) {
  if (!val) return "";
  if (Object.prototype.toString.call(val) === "[object Date]" && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, TIMEZONE, "HH:mm");
  }
  var s = val.toString().trim();
  if (s.indexOf("T") !== -1) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, TIMEZONE, "HH:mm");
    }
  }
  if (s.indexOf(":") !== -1) {
    var parts = s.split(":");
    var h = parts[0].trim();
    var m = parts[1].trim();
    if (h.length === 1) h = "0" + h;
    if (m.length === 1) m = "0" + m;
    return h + ":" + m.substring(0, 2);
  }
  return s;
}

// 顧客前台專用：只回傳時段與狀態（徹底過濾姓名、電話、LINE ID、備註等個人隱私）
function getPublicBookings(callback) {
  var sheet = getOrCreateSheet("Bookings");
  var lastRow = sheet.getLastRow();
  var slots = [];
  
  if (lastRow > 1) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var displayData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
    var rawData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    
    var dateIdx = headers.indexOf("date");
    var timeIdx = headers.indexOf("time");
    var statusIdx = headers.indexOf("status");
    
    if (dateIdx === -1) dateIdx = 4;
    if (timeIdx === -1) timeIdx = 5;
    if (statusIdx === -1) statusIdx = 11;
    
    for (var i = 0; i < displayData.length; i++) {
      var dRow = displayData[i];
      var rRow = rawData[i];
      
      var cleanDate = formatCellDate(dRow[dateIdx]) || formatCellDate(rRow[dateIdx]);
      var cleanTime = formatCellTime(dRow[timeIdx]) || formatCellTime(rRow[timeIdx]);
      var status = (dRow[statusIdx] || rRow[statusIdx] || "待確認").toString().trim();
      
      if (cleanDate && cleanTime) {
        slots.push({
          date: cleanDate,
          time: cleanTime,
          status: status
        });
      }
    }
  }
  return createResponse(slots, callback);
}

// 後台管理專用：回傳完整預約資料 (需密碼認證)
function getFullBookings(callback) {
  var sheet = getOrCreateSheet("Bookings");
  var lastRow = sheet.getLastRow();
  var bookings = [];
  
  if (lastRow > 1) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var displayData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
    var rawData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    
    for (var i = 0; i < displayData.length; i++) {
      var dRow = displayData[i];
      var rRow = rawData[i];
      var booking = {};
      for (var j = 0; j < headers.length; j++) {
        var key = headers[j];
        if (key === "date") {
          booking[key] = formatCellDate(dRow[j]) || formatCellDate(rRow[j]);
        } else if (key === "time") {
          booking[key] = formatCellTime(dRow[j]) || formatCellTime(rRow[j]);
        } else {
          booking[key] = dRow[j] !== "" ? dRow[j] : rRow[j];
        }
      }
      bookings.push(booking);
    }
  }
  return createResponse(bookings, callback);
}

// 兼容舊版 getBookings 接口（預設使用公開脫敏版保護個資）
function getBookings(callback) {
  return getPublicBookings(callback);
}

// 新增預約 (含高併發排他鎖與雲端防重複時段檢查)
function addBooking(bookingData, callback) {
  if (!bookingData || !bookingData.date || !bookingData.time) {
    return createResponse({ success: false, error: "預約資料不完整" }, callback);
  }

  var lock = LockService.getScriptLock();
  try {
    // 等待最多 10 秒取得執行鎖，保證多人同時預約不會發生時段衝突
    lock.waitLock(10000);
  } catch (e) {
    return createResponse({ success: false, error: "系統忙碌中，請稍後再試！" }, callback);
  }

  try {
    var sheet = getOrCreateSheet("Bookings");
    var headers = ["id", "name", "phone", "line", "date", "time", "material", "position", "potion", "totalPrice", "note", "status", "createTime"];
    
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
    }
    
    var targetDate = formatCellDate(bookingData.date);
    var targetTime = formatCellTime(bookingData.time);
    
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var displayData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
      var rawData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
      
      for (var i = 0; i < displayData.length; i++) {
        var dRow = displayData[i];
        var rRow = rawData[i];
        
        var rowDate = formatCellDate(dRow[4]) || formatCellDate(rRow[4]);
        var rowTime = formatCellTime(dRow[5]) || formatCellTime(rRow[5]);
        var status = (dRow[11] || rRow[11] || "待確認").toString().trim();
        
        if (rowDate === targetDate && rowTime === targetTime && status !== "已取消") {
          return createResponse({ success: false, conflict: true, error: "抱歉！該時段剛剛已被其他顧客預約走了，請選擇其他時段！" }, callback);
        }
      }
    }
    
    var newRow = headers.map(function(key) {
      if (key === "date") return targetDate;
      if (key === "time") return targetTime;
      return bookingData[key] !== undefined ? bookingData[key] : "";
    });
    
    sheet.appendRow(newRow);
    return createResponse({ success: true }, callback);
  } finally {
    lock.releaseLock();
  }
}

// 修改預約狀態
function updateBookingStatus(id, status, callback) {
  var sheet = getOrCreateSheet("Bookings");
  var lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0].toString() === id.toString()) {
        sheet.getRange(i + 2, 12).setValue(status); // 第 12 欄是 status (狀態)
        return createResponse({ success: true }, callback);
      }
    }
  }
  return createResponse({ success: false, error: "找不到該預約編號" }, callback);
}

// 修改預約備註
function updateBookingNote(id, note, callback) {
  var sheet = getOrCreateSheet("Bookings");
  var lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0].toString() === id.toString()) {
        sheet.getRange(i + 2, 11).setValue(note); // 第 11 欄是 note (備註)
        return createResponse({ success: true }, callback);
      }
    }
  }
  return createResponse({ success: false, error: "找不到該預約編號" }, callback);
}

// 刪除預約
function deleteBooking(id, callback) {
  var sheet = getOrCreateSheet("Bookings");
  var lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0].toString() === id.toString()) {
        sheet.deleteRow(i + 2);
        return createResponse({ success: true }, callback);
      }
    }
  }
  return createResponse({ success: false, error: "找不到該預約編號" }, callback);
}

// 讀取營業配置
function getConfig(callback) {
  var sheet = getOrCreateSheet("Config");
  var lastRow = sheet.getLastRow();
  var configVal = "";
  
  if (lastRow > 0) {
    var data = sheet.getRange(1, 1, lastRow, 2).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] === "sys_config") {
        configVal = data[i][1];
        break;
      }
    }
  }
  
  return createResponse({ configStr: configVal }, callback);
}

// 儲存營業配置
function saveConfig(configData, callback) {
  var sheet = getOrCreateSheet("Config");
  var lastRow = sheet.getLastRow();
  var foundRow = 0;
  
  if (lastRow > 0) {
    var keys = sheet.getRange(1, 1, lastRow, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i][0] === "sys_config") {
        foundRow = i + 1;
        break;
      }
    }
  }
  
  var configStr = JSON.stringify(configData);
  if (foundRow > 0) {
    sheet.getRange(foundRow, 2).setValue(configStr);
  } else {
    sheet.appendRow(["sys_config", configStr]);
  }
  return createResponse({ success: true }, callback);
}

// 取得或自動建立工作表分頁
function getOrCreateSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

// 建立跨網域回傳物件 (支援 JSON 與 JSONP)
function createResponse(data, callbackName) {
  var jsonString = JSON.stringify(data);
  if (callbackName) {
    var jsContent = callbackName + "(" + jsonString + ");";
    return ContentService.createTextOutput(jsContent)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } else {
    return ContentService.createTextOutput(jsonString)
      .setMimeType(ContentService.MimeType.JSON);
  }
}
