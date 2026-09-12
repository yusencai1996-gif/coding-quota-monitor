export function trustedSender(senderId:number,expectedId:number,frame:unknown,mainFrame:unknown,url:string,expectedUrl:string){return senderId===expectedId&&frame===mainFrame&&url===expectedUrl;}
