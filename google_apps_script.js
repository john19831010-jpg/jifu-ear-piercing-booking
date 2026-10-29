// google_apps_script.js
// 適用於「吉富珠寶銀樓穿耳預約系統」的雲端試算表資料庫轉接器
// 請複製整份檔案，並貼入您 Google 試算表的「延伸模組」->「Apps Script」中。

// 後台管理密碼（集中於伺服器端驗證，不在前端暴露）
var ADMIN_PASSWORD = "jifu888";

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
    var data = JSON.parse(decodeURIComponent(e.parameter.data));
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
    var data = JSON.parse(decodeURIComponent(e.parameter.data));
    return saveConfig(data, callback);
  }
  
  return createResponse({ error: "Invalid GET action" }, callback);
}

function doPost(e) {
  // 同步支援 POST 寫入作為備用
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

// 顧客前台專用：只回傳時段與狀態（徹底過濾姓名、電話、LINE ID、備註等個人隱私）
function getPublicBookings(callback) {
  var sheet = getOrCreateSheet("Bookings");
  var lastRow = sheet.getLastRow();
  var slots = [];
  
  if (lastRow > 1) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    
    var dateIdx = headers.indexOf("date");
    var timeIdx = headers.indexOf("time");
    var statusIdx = headers.indexOf("status");
    
    // 若標頭未找到，退回標準欄位索引 (date:4, time:5, status:11)
    if (dateIdx === -1) dateIdx = 4;
    if (timeIdx === -1) timeIdx = 5;
    if (statusIdx === -1) statusIdx = 11;
    
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      slots.push({
        date: row[dateIdx],
        time: row[timeIdx],
        status: row[statusIdx] || "待確認"
      });
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
    var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var booking = {};
      for (var j = 0; j < headers.length; j++) {
        booking[headers[j]] = row[j];
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

// 新增預約 (含雲端衝突防護)
function addBooking(bookingData, callback) {
  var sheet = getOrCreateSheet("Bookings");
  var headers = ["id", "name", "phone", "line", "date", "time", "material", "position", "potion", "totalPrice", "note", "status", "createTime"];
  
  // 檢查並建立標頭
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  
  // 進行防重複預約的雲端最終檢查
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      // 比對日期 (索引 4) 與時間 (索引 5) 且狀態 (索引 11) 不是「已取消」
      if (row[4].toString() === bookingData.date.toString() && 
          row[5].toString() === bookingData.time.toString() && 
          row[11].toString() !== "已取消") {
        return createResponse({ success: false, conflict: true, error: "這個時段已被他人預約佔用！" }, callback);
      }
    }
  }
  
  var newRow = headers.map(function(key) {
    return bookingData[key] !== undefined ? bookingData[key] : "";
  });
  
  sheet.appendRow(newRow);
  return createResponse({ success: true }, callback);
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

// 建立跨網域回傳物件 (支援 JSONP)
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
