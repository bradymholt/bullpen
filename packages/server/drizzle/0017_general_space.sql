UPDATE `agents` SET `space` = 'General' WHERE `space` IS NULL OR trim(`space`) = '';
