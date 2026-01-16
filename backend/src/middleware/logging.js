import pinoHttp from 'pino-http';
import logger from '../../logger.js';

export const logging = pinoHttp({
  logger,
  serializers:{ req(req){ return { id:req.id, method:req.method, url:req.url, ip:req.ip||req.socket?.remoteAddress }; }, res(res){ return { statusCode:res.statusCode }; } },
  customLogLevel(res,err){ if (err||res.statusCode>=500) return 'error'; if (res.statusCode>=400) return 'warn'; return 'info'; },
  customSuccessMessage(req,res){ return `ok ${req.method} ${req.url} ${res.statusCode}`; },
  customErrorMessage(req,res){ return `err ${req.method} ${req.url} ${res.statusCode||500}`; },
  customProps(req){ return { cnpj:req.body?.cnpj||req.query?.cnpj, reportId:req.params?.id }; },
  autoLogging:{ ignore:(req)=>req.url==='/health' },
});
