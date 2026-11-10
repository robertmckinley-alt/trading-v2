const fs=require('node:fs'),path=require('node:path');
function readReport(cachePath){
 let report=JSON.parse(fs.readFileSync(cachePath));
 const auditDir=path.join(path.dirname(cachePath),'execution-audit');
 try{
  const after=JSON.parse(fs.readFileSync(path.join(auditDir,'after.json')));
  if(Date.parse(after.generatedAt)>Date.parse(report.generatedAt))report=after;
 }catch{ /* Comparison has not finished. */ }
 try{report={...report,executionAudit:JSON.parse(fs.readFileSync(path.join(auditDir,'comparison.json')))};}catch{ /* No completed comparison. */ }
 try{report={...report,executionAuditProgress:JSON.parse(fs.readFileSync(path.join(auditDir,'progress.json')))};}catch{ /* Not started. */ }
 return report;
}
module.exports={readReport};
