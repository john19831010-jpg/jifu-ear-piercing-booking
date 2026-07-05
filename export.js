// --- 匯出 Excel (.xlsx) 邏輯 ---

function exportBookingsToExcel() {
  // 檢查是否有 SheetJS 庫
  if (typeof XLSX === "undefined") {
    alert("Excel 匯出元件載入失敗，請確認您的網路連線是否正常！");
    return;
  }
  
  // 取得最新 bookings 清單
  const bookings = JSON.parse(localStorage.getItem("jifu_piercing_bookings")) || [];
  
  if (bookings.length === 0) {
    alert("目前沒有任何預約資料可以匯出！");
    return;
  }
  
  // 建立欲匯出的資料陣列，並將欄位中文化
  const exportData = bookings.map(b => {
    return {
      "預約日期": b.date,
      "預約時段": b.time,
      "顧客姓名": b.name,
      "手機號碼": b.phone,
      "LINE ID": b.line,
      "耳針材質": b.material,
      "穿耳位置": b.position,
      "加購保養藥水": b.potion,
      "預估總金額": b.totalPrice,
      "預約狀態": b.status,
      "顧客/內部備註": b.note,
      "預約建立時間": b.createTime
    };
  });
  
  // 依照「預約日期」由新到舊，「預約時段」由早到晚進行排序
  exportData.sort((a, b) => {
    if (a["預約日期"] !== b["預約日期"]) {
      return b["預約日期"].localeCompare(a["預約日期"]);
    }
    return a["預約時段"].localeCompare(b["預約時段"]);
  });
  
  // 1. 建立新的工作簿 Workbook
  const wb = XLSX.utils.book_new();
  
  // 2. 將 JSON 資料轉換為工作表 Worksheet
  const ws = XLSX.utils.json_to_sheet(exportData);
  
  // 3. 設定欄寬 (以字元數為基礎微調)
  const colWidths = [
    { wch: 12 }, // 預約日期
    { wch: 10 }, // 預約時段
    { wch: 12 }, // 顧客姓名
    { wch: 14 }, // 手機號碼
    { wch: 14 }, // LINE ID
    { wch: 25 }, // 耳針材質
    { wch: 14 }, // 穿耳位置
    { wch: 12 }, // 加購保養藥水
    { wch: 14 }, // 預估總金額
    { wch: 10 }, // 預約狀態
    { wch: 30 }, // 顧客/內部備註
    { wch: 20 }  // 預約建立時間
  ];
  ws['!cols'] = colWidths;
  
  // 4. 將工作表附加到工作簿，命名為「穿耳預約清單」
  XLSX.utils.book_append_sheet(wb, ws, "穿耳預約清單");
  
  // 5. 下載 Excel 檔案
  const dateStr = new Date().toISOString().split("T")[0];
  const filename = `吉富珠寶_穿耳預約名單_${dateStr}.xlsx`;
  
  try {
    XLSX.writeFile(wb, filename);
  } catch (error) {
    console.error("Excel write error:", error);
    alert("匯出 Excel 時發生錯誤，請稍後再試！");
  }
}
